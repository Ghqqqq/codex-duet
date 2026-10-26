import { atom, read } from 'claude-code';
import type { EngineInterface } from 'claude-code';
import type { CodexLiveJob, CodexLiveMarker, CodexLiveState } from '../types';
import { ATTENTION_SESSION_LIMIT, attention, boundState, clean, detailedTurns, expireQuestion, fitState, groupedSessions, jobSummary, jobView, markerView, normalizeSessions, oldestJob,
  retainedTurns, sessionForId, sessionId, statusLine, unavailableJob, visibleSessions } from './model';
import { feedLines, paneLayout, normalizeFeed, recentEndedJobIds, selectedJob } from './layout';
import { checkedView, publishView, reportFailure, updateFailure, viewports } from './runtime';

const view = atom({ plugin: 'codex-live', key: 'view' } as const,
  { jobs: [], selectedId: null, nowMs: 0 } as CodexLiveState);

type Cached = {
  marker: CodexLiveMarker;
  markerName: string;
  job: CodexLiveJob;
  raw?: unknown;
  full?: CodexLiveJob;
  processedMtime?: number;
  nextCheck: number;
  firstEnded?: number;
};

export function createPoller($: EngineInterface, diagnostics?: { onCompose?(): void; onBound?(): void; onLayout?(): void }): (force?: boolean) => Promise<void> {
  let busy = false;
  let tick = 0;
  let session = '';
  let home = '';
  let canonical = false;
  let lastStatus: string | undefined;
  const cache = new Map<string, Cached>();
  // Evicted entries keep only a header summary and file identity, never raw/details.
  const evicted = new Map<string, Pick<Cached, 'job' | 'processedMtime' | 'marker' | 'firstEnded'>>();
  const markerNames = new Set<string>();
  const retryMarker = new Map<string, number>();
  const markerErrors = new Map<string, string>();
  let lastDiscovery = '';
  // Keep only identities after ownership moves, including across failed writes.
  const foreignJobs = new Set<string>();
  // Successful observations outside the retained view live only while present.
  const knownJobs = new Set<string>();
  let bounded: { key: string; sources: (CodexLiveJob | undefined)[]; state: CodexLiveState } | undefined;

  return async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      tick++;
      const stored = await read($, view);
      let current = checkedView($, stored);
      const repaired = current !== stored;
      const expected = JSON.stringify(stored);
      const paneOpen = (await $.ui.panes()).some(pane => pane.id === 'codex-live');
      if (!force && !repaired && !groupedSessions(current.jobs).some(job => job.active) && !paneOpen && tick % 5 !== 1) return;
      const now = await $.clock.now();
      const currentSession = await $.session.id();
      const sessionChanged = !!current.sessionId && current.sessionId !== currentSession;
      if (session !== currentSession || repaired) {
        session = currentSession;
        cache.clear(); evicted.clear(); markerNames.clear(); retryMarker.clear(); foreignJobs.clear(); knownJobs.clear();
        markerErrors.clear(); lastDiscovery = '';
        bounded = undefined;
      }
      if (sessionChanged) current = { jobs: [], selectedId: null, nowMs: 0 };
      const previouslySeen = new Set(current.seenJobIds ?? current.jobs.map(job => job.id));
      const previouslyKnown = new Set([...previouslySeen, ...current.jobs.map(job => job.id),
        ...knownJobs]);
      const previousLatest = new Map(groupedSessions(current.jobs).map(group => [group.id, group.turns.at(-1)!]));
      const seen = new Set(previouslySeen);
      const joinedThreads = new Set<string>();
      const opened = new Set(current.autoOpenedJobIds ?? current.jobs.filter(job => job.active).map(job => job.id));
      const firstEndedAtMs = { ...current.firstEndedAtMs };
      if (!home) {
        const override = await $.env.get('CODEX_COMPANION_HOME');
        const userHome = await $.env.get('HOME');
        home = override || (userHome ? `${userHome}/.claude/codex-isolated` : '');
        if (!home) return;
      }
      if (!canonical && await $.fs.exists(home)) {
        home = (await $.fs.stat(home, { resolve: true })).realPath || home;
        canonical = true;
      }
      const folder = `${home.replace(/\/$/, '')}/duet/sessions/${session}`;
      let directoryError = '';
      const diagnostic = (error: unknown) => clean(error instanceof Error ? error.message : String(error)).slice(0, 300);
      const entries = await $.fs.list(folder).catch(error => {
        // A fresh session has no marker directory yet. Other failures must not
        // be mistaken for an empty inventory, even if cached jobs are readable.
        const missing = error?.code === 'ENOENT' || /\bENOENT\b|no such file or directory/i.test(diagnostic(error));
        if (missing && !previouslyKnown.size && current.hiddenFinishedBefore === undefined && !current.hiddenJobIds?.length) return [];
        directoryError = diagnostic(error) || 'Directory unreadable';
        return undefined;
      });
      const presentMarkers = entries && new Set(entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
        .map(entry => entry.name));
      if (presentMarkers) for (const name of evicted.keys()) if (!presentMarkers.has(name)) evicted.delete(name);
      if (presentMarkers) {
        for (const name of retryMarker.keys()) if (!presentMarkers.has(name)) retryMarker.delete(name);
        for (const name of markerErrors.keys()) if (!presentMarkers.has(name)) markerErrors.delete(name);
        // A failed publication leaves candidates in cache; pruned finished
        // candidates must not accumulate while the last good view is retained.
        const retainedIds = new Set(current.jobs.map(job => job.id));
        for (const [id, entry] of cache) if (!presentMarkers.has(entry.markerName) && !retainedIds.has(id) &&
          entry.job.finished && !entry.job.unresolved) {
          cache.delete(id); markerNames.delete(entry.markerName); foreignJobs.delete(id);
        }
      }
      for (const entry of entries ?? []) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json') || markerNames.has(entry.name) || now < (retryMarker.get(entry.name) ?? 0)) continue;
        try {
          const marker = markerView(JSON.parse(await $.fs.read(`${folder}/${entry.name}`)));
          const previous = !foreignJobs.has(marker.jobId) ? current.jobs.find(job => job.id === marker.jobId) : undefined;
          const remembered = evicted.get(entry.name);
          const memo = remembered?.job.id === marker.jobId && remembered.marker.jobFile === marker.jobFile ? remembered : undefined;
          if (!cache.has(marker.jobId)) cache.set(marker.jobId, {
            marker, markerName: entry.name, job: memo?.job ?? (previous ? jobSummary(previous) : unavailableJob(marker)),
            processedMtime: memo?.processedMtime,
            firstEnded: memo?.firstEnded,
            full: previous?.detailsLoaded !== false ? previous : undefined, nextCheck: 0,
          });
          evicted.delete(entry.name);
          markerNames.add(entry.name); // Only a successful parse marks the marker seen.
          retryMarker.delete(entry.name);
          markerErrors.delete(entry.name);
        } catch (error) {
          retryMarker.set(entry.name, now + 5000);
          markerErrors.set(entry.name, diagnostic(error));
        }
      }
      const discoveryWarning = directoryError ? 'Discovery warning: session directory unreadable; inventory may be incomplete'
        : markerErrors.size ? `Discovery warning: ${markerErrors.size} unreadable session markers; inventory may be incomplete` : undefined;
      const discovery = discoveryWarning ? JSON.stringify([directoryError, [...markerErrors].sort()]) : '';
      if (discovery !== lastDiscovery) {
        $.ui.log(`codex-live: ${discoveryWarning ?? 'Discovery recovered'}${directoryError ? ` · ${directoryError}` : ''}`, { to: 'debug' });
        lastDiscovery = discovery;
      }
      const newlyActive: string[] = [];
      const belongsHere = (raw: { sessionId?: unknown } | null, entry: Cached): boolean => {
        const id = entry.marker.jobId;
        // Missing session IDs are legacy records scoped by their marker.
        if (typeof raw?.sessionId !== 'string' || !raw.sessionId || raw.sessionId === currentSession) {
          foreignJobs.delete(id);
          return true;
        }
        foreignJobs.add(id);
        cache.delete(id);
        evicted.delete(entry.markerName);
        markerNames.delete(entry.markerName);
        retryMarker.set(entry.markerName, now + 10000);
        return false;
      };
      // Read before eviction: a newly discovered old marker may describe a live job.
      for (const entry of cache.values()) {
        if (now < entry.nextCheck) continue;
        try {
          const stat = await $.fs.stat(entry.marker.jobFile);
          if (stat.mtimeMs !== entry.processedMtime) {
            const raw = JSON.parse(await $.fs.read(entry.marker.jobFile));
            if (!belongsHere(raw, entry)) continue;
            const job = jobView(raw, entry.marker, false, now);
            if ((entry.processedMtime !== undefined || current.jobs.some(previous => previous.id === job.id)) &&
                sessionId(entry.job) !== sessionId(job)) joinedThreads.add(job.id);
            entry.raw = raw;
            entry.full = undefined;
            entry.job = { ...job, lastUpdateMs: now };
            entry.processedMtime = stat.mtimeMs; // Commit only after read + parse + projection succeeded.
          } else if (entry.job.detailsUnavailable) entry.job = { ...entry.job, detailsUnavailable: false };
          entry.nextCheck = entry.job.finished ? now + 10000 : 0;
        } catch {
          entry.job = { ...entry.job, detailsUnavailable: true };
          entry.nextCheck = now + 5000;
        }
      }
      for (const entry of cache.values()) {
        if (foreignJobs.has(entry.job.id)) continue;
        // Also retry bookkeeping after a rejected state write with unchanged mtime.
        if (entry.processedMtime !== undefined) {
          if (!previouslyKnown.has(entry.job.id) && entry.job.active && !opened.has(entry.job.id)) newlyActive.push(entry.job.id);
          seen.add(entry.job.id);
        }
        if (entry.job.finished) {
          // A reloaded cleared history has no retained end observation. Keep
          // its creation-time fallback instead of making it newly finished.
          // Jobs still in the last good view (including active-at-clear jobs)
          // continue to receive their actual first observed end time.
          const clearedHistory = current.hiddenFinishedBefore !== undefined && !current.jobs.some(job => job.id === entry.job.id)
            ? Date.parse(entry.job.createdAt) : NaN;
          entry.firstEnded ??= firstEndedAtMs[entry.job.id] ?? (Number.isFinite(clearedHistory) ? clearedHistory : now);
          firstEndedAtMs[entry.job.id] = entry.firstEnded;
        } else if (entry.job.active || entry.job.unresolved) { delete firstEndedAtMs[entry.job.id]; entry.firstEnded = undefined; }
      }
      // A reload may coincide with an unreadable marker/directory. Keep the
      // persisted last good view until its marker can be rediscovered.
      const restored: Cached[] = current.jobs.filter(job => !cache.has(job.id) && !foreignJobs.has(job.id)).map(job => ({
        marker: { jobId: job.id, jobFile: '', summary: job.label, title: '', createdAt: job.createdAt },
        markerName: '', job: { ...jobSummary(job), detailsUnavailable: true },
        full: job.detailsLoaded !== false ? job : undefined, nextCheck: Infinity,
      }));
      // Include evicted summaries when grouping: a follow-up can immediately
      // restore its entire conversation before the marker's retry deadline.
      const knownIds = new Set([...cache.keys(), ...restored.map(entry => entry.job.id)]);
      const remembered: Cached[] = [...evicted.entries()].filter(([, entry]) => !knownIds.has(entry.job.id))
        .map(([markerName, entry]) => ({ ...entry, markerName, nextCheck: now + 10000 }));
      let newest = [...cache.values(), ...restored, ...remembered].filter(entry => !foreignJobs.has(entry.job.id))
        .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || b.job.id.localeCompare(a.job.id));
      // Expiry is a clock transition, including when the file is unchanged or unreadable.
      for (const entry of newest) {
        entry.job = expireQuestion(entry.job, now);
        if (entry.full) entry.full = expireQuestion(entry.full, now);
      }
      const byId = new Map(newest.map(entry => [entry.job.id, entry]));
      for (const id of newlyActive) opened.add(id);
      // Selection and hydration use lightweight summaries, before any event
      // serialization or transcript layout. Replanning is cheap after hydration.
      const plan = (latest: CodexLiveState) => {
        const turnCounts = { ...latest.turnCounts };
        for (const entry of newest) if ((!previouslyKnown.has(entry.job.id) && seen.has(entry.job.id)) || joinedThreads.has(entry.job.id)) {
          const id = sessionId(entry.job);
          // After reload, older omitted turns are rediscovered from markers.
          // Their count is already included; only newer arrivals extend it.
          const previous = previousLatest.get(id);
          if (!previous || oldestJob(entry.job, previous) > 0 || joinedThreads.has(entry.job.id)) {
            turnCounts[id] = (turnCounts[id] ?? 0) + 1;
          }
        }
        // Include this tick's first end observations before deciding visibility.
        const removedSessions = new Set(latest.jobs.filter(job => foreignJobs.has(job.id)).map(sessionId));
        const feeds = removedSessions.size && latest.feeds
          ? Object.fromEntries(Object.entries(latest.feeds).filter(([id]) => !foreignJobs.has(id) && !removedSessions.has(id)))
          : latest.feeds;
        const visibility = normalizeSessions({ ...latest, jobs: newest.map(entry => entry.job), feeds, firstEndedAtMs, turnCounts });
        const visible = visibleSessions(visibility);
        const selectedSession = sessionForId(visible, visibility.selectedId);
        const activated = visible.filter(session => session.turns.some(job => newlyActive.includes(job.id)));
        // Preserve the reader's conversation, including stopped feed anchors.
        // Follow-ups already share its session ID; only an absent selection
        // allows a newly activated conversation to take focus.
        const selectedId = selectedSession?.id ?? activated[0]?.id
          ?? visible.find(session => session.active)?.id ?? visible[0]?.id ?? null;
        const protectedAttention = new Set(visible.filter(session => attention(session) === 'blocked')
          .sort((a, b) => oldestJob(b, a)).slice(0, ATTENTION_SESSION_LIMIT).map(session => session.id));
        const retained = visible.filter((session, i) => i < 20 || session.active || session.unresolved ||
          session.id === selectedId || protectedAttention.has(session.id));
        const retainedSessions = new Set(retained.map(session => session.id));
        const attentionOmitted = visible.filter(session => attention(session) && !retainedSessions.has(session.id)).length;
        const retainedIds = new Set(retained.flatMap(session => retainedTurns(session).map(job => job.id)));
        const selected = sessionForId(retained, selectedId);
        const detailedIds = new Set(selected ? detailedTurns(selected).map(job => job.id) : []);
        for (const session of visible) turnCounts[session.id] = session.turnCount;
        return { visibility, selectedId, retained, retainedSessions, retainedIds, detailedIds, turnCounts, attentionOmitted };
      };
      let planned = plan(current);
      let hydrated = false;
      // An unchanged mtime cannot hydrate details discarded during eviction.
      // Only the five newest selected turns may trigger these extra reads.
      for (const id of planned.detailedIds) {
        const entry = byId.get(id)!;
        if (entry.raw || entry.full || !entry.marker.jobFile || entry.job.detailsUnavailable) continue;
        hydrated = true;
        try {
          const stat = await $.fs.stat(entry.marker.jobFile);
          const raw = JSON.parse(await $.fs.read(entry.marker.jobFile));
          if (!belongsHere(raw, entry)) continue;
          const summary = jobView(raw, entry.marker, false, now);
          entry.raw = raw;
          entry.job = { ...summary, lastUpdateMs: now };
          entry.processedMtime = stat.mtimeMs;
          entry.nextCheck = entry.job.finished ? now + 10000 : 0;
          if (entry.job.finished) firstEndedAtMs[id] = entry.firstEnded ??= firstEndedAtMs[id] ?? now;
          else if (entry.job.active || entry.job.unresolved) { delete firstEndedAtMs[id]; entry.firstEnded = undefined; }
        } catch { entry.job = { ...entry.job, detailsUnavailable: true }; entry.nextCheck = now + 5000; }
      }
      if (hydrated) {
        newest = newest.filter(entry => !foreignJobs.has(entry.job.id));
        planned = plan(current);
      }
      const compose = (latest: CodexLiveState, selection?: ReturnType<typeof plan>): CodexLiveState => {
        diagnostics?.onCompose?.();
        if (sessionChanged && latest.sessionId !== currentSession) latest = current;
        const { visibility, selectedId, retained, retainedSessions, retainedIds, detailedIds, turnCounts, attentionOmitted } = selection ?? plan(latest);
        const sources: (CodexLiveJob | undefined)[] = [];
        const jobs = newest.filter(entry => retainedIds.has(entry.job.id)).map(entry => {
          sources.push(entry.job);
          if (!detailedIds.has(entry.job.id)) return entry.job;
          if (!entry.full && entry.raw) entry.full = jobView(entry.raw, entry.marker, true, now);
          sources.push(entry.full);
          return entry.full ? { ...entry.full, detailsUnavailable: entry.job.detailsUnavailable, lastUpdateMs: entry.job.lastUpdateMs } : entry.job;
        });
        const active = retained.some(session => session.active);
        const stale = jobs.some(job => job.detailsUnavailable);
        const nowMs = active || stale ? Math.floor(now / 5000) * 5000 : latest.nowMs;
        let candidate: CodexLiveState = { ...latest, jobs, selectedId, nowMs, sessionId: currentSession,
          turnCounts: Object.fromEntries(Object.entries(turnCounts).filter(([id]) => retainedSessions.has(id))),
          discoveryWarning, attentionOmitted,
          spinnerTick: active && (paneOpen || newlyActive.length) ? Math.floor(now / 1000) : latest.spinnerTick,
          feeds: visibility.feeds && Object.fromEntries(Object.entries(visibility.feeds).filter(([id]) => retainedSessions.has(id))),
          viewedSessionIds: visibility.viewedSessionIds,
          newSessionIds: [...new Set([...(visibility.newSessionIds ?? []),
            ...retained.filter(session => session.turns.some(job => newlyActive.includes(job.id)) &&
              !visibility.viewedSessionIds?.includes(session.id)).map(session => session.id)])]
            .filter(id => retainedSessions.has(id) && id !== selectedId),
          // Omitted marker rediscovery must not invalidate an unchanged retained transcript.
          seenJobIds: [...seen].filter(id => retainedIds.has(id)), autoOpenedJobIds: [...opened].filter(id => retainedIds.has(id)),
          firstEndedAtMs: Object.fromEntries(Object.entries(firstEndedAtMs).filter(([id]) => retainedIds.has(id))),
          recentEndedIds: recentEndedJobIds(retained, now, job => {
            const end = Date.parse(job.completedAt);
            const latestId = sessionForId(retained, job.id)!.lifecycleJobId;
            return Number.isFinite(end) ? end : firstEndedAtMs[latestId] ?? NaN;
          }),
        };
        // Closed panes retain their last feed anchor. Reuse the bounded projection
        // when only the clock/spinner changed; content identities and all other
        // state (including selection and concurrent interactions) invalidate it.
        const key = JSON.stringify({ ...candidate, jobs: undefined, nowMs: undefined, spinnerTick: undefined });
        if (!paneOpen && bounded?.key === key && sources.length === bounded.sources.length &&
            sources.every((source, i) => source === bounded!.sources[i])) {
          candidate = { ...bounded.state, nowMs, spinnerTick: candidate.spinnerTick };
        } else {
          diagnostics?.onBound?.();
          candidate = boundState(candidate);
          bounded = { key, sources, state: { ...candidate } };
        }
        // Only the selected transcript is laid out. Other stopped windows keep
        // their small content anchors/snapshots until selected again.
        const selected = selectedJob(candidate);
        const feed = selectedId ? candidate.feeds?.[selectedId] : undefined;
        if (paneOpen && selected && feed) {
          const measured = viewports.get(feed.surface ?? 'terminal');
          const columns = measured?.columns ?? feed.columns;
          const rows = measured ? paneLayout(candidate, selected, measured.bodyRows).rows : feed.rows ?? 8;
          if (columns) {
            diagnostics?.onLayout?.();
            candidate.feeds = { ...candidate.feeds, [selected.id]: normalizeFeed(feedLines(selected, nowMs, columns, feed), rows, { ...feed, columns }) };
          }
        }
        return fitState(candidate);
      };
      let candidate = compose(current, planned);
      if (JSON.stringify(candidate) !== expected || updateFailure()) {
        const published = await publishView($, expected, candidate, compose);
        if (!published) return;
        candidate = published; // Status and eviction must use the view actually saved.
      }
      const retainedIds = new Set(candidate.jobs.map(job => job.id));
      knownJobs.clear();
      for (const entry of [...cache.values(), ...remembered]) if (entry.processedMtime !== undefined &&
        (retainedIds.has(entry.job.id) || !presentMarkers || presentMarkers.has(entry.markerName))) knownJobs.add(entry.job.id);
      for (const entry of remembered) if (retainedIds.has(entry.job.id)) {
        cache.set(entry.job.id, entry);
        evicted.delete(entry.markerName);
        markerNames.add(entry.markerName);
        retryMarker.delete(entry.markerName);
      }
      for (const [id, entry] of cache) if (!retainedIds.has(id)) {
        if (!foreignJobs.has(id) && (!presentMarkers || presentMarkers.has(entry.markerName))) evicted.set(entry.markerName, {
          job: jobSummary(entry.job), processedMtime: entry.processedMtime, marker: entry.marker, firstEnded: entry.firstEnded,
        });
        cache.delete(id);
        markerNames.delete(entry.markerName);
        retryMarker.set(entry.markerName, now + 10000); // Eviction is not a permanent "seen" tombstone.
      }
      const status = [candidate.discoveryWarning, statusLine(candidate.jobs, candidate.attentionOmitted)].filter(Boolean).join(' · ') || undefined;
      if (status !== lastStatus) { $.ui.status(status); lastStatus = status; }
      if (newlyActive.length) await $.ui.open({ id: 'codex-live', title: 'Codex' });
    } catch (error) { reportFailure($, error); }
    finally { busy = false; }
  };
}
