import { atom, read } from 'claude-code';
import type { EngineInterface } from 'claude-code';
import type { CodexLiveJob, CodexLiveMarker, CodexLiveState } from '../types';
import { boundState, DETAIL_TURN_LIMIT, fitState, groupedSessions, jobSummary, jobView, markerView, normalizeSessions,
  retainedTurns, sessionForId, sessionId, statusLine, unavailableJob, visibleSessions } from './model';
import { feedLines, paneLayout, normalizeFeed, recentEndedJobIds, selectedJob } from './layout';
import { publishView, reportFailure, updateFailure, viewports } from './runtime';

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

export function createPoller($: EngineInterface, diagnostics?: { onCompose(): void }): (force?: boolean) => Promise<void> {
  let busy = false;
  let tick = 0;
  let session = '';
  let home = '';
  let canonical = false;
  let lastStatus: string | undefined;
  const cache = new Map<string, Cached>();
  // Evicted entries keep only a header summary and file identity, never raw/details.
  const evicted = new Map<string, Pick<Cached, 'job' | 'processedMtime' | 'marker'>>();
  const markerNames = new Set<string>();
  const retryMarker = new Map<string, number>();

  return async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      tick++;
      let current = await read($, view);
      const expected = JSON.stringify(current);
      const paneOpen = (await $.ui.panes()).some(pane => pane.id === 'codex-live');
      if (!force && !groupedSessions(current.jobs).some(job => job.active) && !paneOpen && tick % 5 !== 1) return;
      const now = await $.clock.now();
      const currentSession = await $.session.id();
      const sessionChanged = !!current.sessionId && current.sessionId !== currentSession;
      if (session !== currentSession) {
        session = currentSession;
        cache.clear(); evicted.clear(); markerNames.clear(); retryMarker.clear();
      }
      if (sessionChanged) current = { jobs: [], selectedId: null, nowMs: 0 };
      const previouslySeen = new Set(current.seenJobIds ?? current.jobs.map(job => job.id));
      const previouslyKnown = new Set([...previouslySeen, ...current.jobs.map(job => job.id)]);
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
      const entries = await $.fs.list(folder).catch(() => undefined);
      const presentMarkers = entries && new Set(entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
        .map(entry => entry.name));
      if (presentMarkers) for (const name of evicted.keys()) if (!presentMarkers.has(name)) evicted.delete(name);
      for (const entry of entries ?? []) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json') || markerNames.has(entry.name) || now < (retryMarker.get(entry.name) ?? 0)) continue;
        try {
          const marker = markerView(JSON.parse(await $.fs.read(`${folder}/${entry.name}`)));
          const previous = current.jobs.find(job => job.id === marker.jobId);
          const remembered = evicted.get(entry.name);
          const memo = remembered?.job.id === marker.jobId && remembered.marker.jobFile === marker.jobFile ? remembered : undefined;
          if (!cache.has(marker.jobId)) cache.set(marker.jobId, {
            marker, markerName: entry.name, job: memo?.job ?? (previous ? jobSummary(previous) : unavailableJob(marker)),
            processedMtime: memo?.processedMtime,
            full: previous?.detailsLoaded !== false ? previous : undefined, nextCheck: 0,
          });
          evicted.delete(entry.name);
          markerNames.add(entry.name); // Only a successful parse marks the marker seen.
          retryMarker.delete(entry.name);
        } catch { retryMarker.set(entry.name, now + 5000); }
      }
      const newlyActive: string[] = [];
      // Read before eviction: a newly discovered old marker may describe a live job.
      for (const entry of cache.values()) {
        if (now < entry.nextCheck) continue;
        try {
          const stat = await $.fs.stat(entry.marker.jobFile);
          if (stat.mtimeMs !== entry.processedMtime) {
            const raw = JSON.parse(await $.fs.read(entry.marker.jobFile));
            const job = jobView(raw, entry.marker, false);
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
        // Also retry bookkeeping after a rejected state write with unchanged mtime.
        if (entry.processedMtime !== undefined) {
          if (!seen.has(entry.job.id) && entry.job.active && !opened.has(entry.job.id)) newlyActive.push(entry.job.id);
          seen.add(entry.job.id);
        }
        if (entry.job.finished) {
          entry.firstEnded ??= firstEndedAtMs[entry.job.id] ?? now;
          firstEndedAtMs[entry.job.id] = entry.firstEnded;
        } else if (entry.job.active) { delete firstEndedAtMs[entry.job.id]; entry.firstEnded = undefined; }
      }
      // A reload may coincide with an unreadable marker/directory. Keep the
      // persisted last good view until its marker can be rediscovered.
      const restored: Cached[] = current.jobs.filter(job => !cache.has(job.id)).map(job => ({
        marker: { jobId: job.id, jobFile: '', summary: job.label, title: '', createdAt: job.createdAt },
        markerName: '', job: { ...jobSummary(job), detailsUnavailable: true },
        full: job.detailsLoaded !== false ? job : undefined, nextCheck: Infinity,
      }));
      // Include evicted summaries when grouping: a follow-up can immediately
      // restore its entire conversation before the marker's retry deadline.
      const knownIds = new Set([...cache.keys(), ...restored.map(entry => entry.job.id)]);
      const remembered: Cached[] = [...evicted.entries()].filter(([, entry]) => !knownIds.has(entry.job.id))
        .map(([markerName, entry]) => ({ ...entry, markerName, nextCheck: now + 10000 }));
      const newest = [...cache.values(), ...restored, ...remembered]
        .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || b.job.id.localeCompare(a.job.id));
      const byId = new Map(newest.map(entry => [entry.job.id, entry]));
      for (const id of newlyActive) opened.add(id);
      // Selection and hydration use lightweight summaries, before any event
      // serialization or transcript layout. Replanning is cheap after hydration.
      const plan = (latest: CodexLiveState) => {
        const turnCounts = { ...latest.turnCounts };
        for (const entry of newest) if ((!previouslyKnown.has(entry.job.id) && seen.has(entry.job.id)) || joinedThreads.has(entry.job.id)) {
          const id = sessionId(entry.job);
          turnCounts[id] = (turnCounts[id] ?? 0) + 1;
        }
        // Include this tick's first end observations before deciding visibility.
        const visibility = normalizeSessions({ ...latest, jobs: newest.map(entry => entry.job), firstEndedAtMs, turnCounts });
        const visible = visibleSessions(visibility);
        const selectedSession = sessionForId(visible, visibility.selectedId);
        const activated = visible.filter(session => session.turns.some(job => newlyActive.includes(job.id)));
        // Preserve the reader's conversation, including stopped feed anchors.
        // Follow-ups already share its session ID; only an absent selection
        // allows a newly activated conversation to take focus.
        const selectedId = selectedSession?.id ?? activated[0]?.id
          ?? visible.find(session => session.active)?.id ?? visible[0]?.id ?? null;
        const retained = visible.filter((session, i) => i < 20 || session.active || session.id === selectedId);
        const retainedSessions = new Set(retained.map(session => session.id));
        const retainedIds = new Set(retained.flatMap(session => retainedTurns(session).map(job => job.id)));
        const selected = sessionForId(retained, selectedId);
        const detailedIds = new Set(selected ? retainedTurns(selected).slice(-DETAIL_TURN_LIMIT).map(job => job.id) : []);
        for (const session of visible) turnCounts[session.id] = session.turnCount;
        return { visibility, selectedId, retained, retainedSessions, retainedIds, detailedIds, turnCounts };
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
          const summary = jobView(raw, entry.marker, false);
          entry.raw = raw;
          entry.job = { ...summary, lastUpdateMs: now };
          entry.processedMtime = stat.mtimeMs;
          entry.nextCheck = entry.job.finished ? now + 10000 : 0;
          if (entry.job.finished) firstEndedAtMs[id] = entry.firstEnded ??= firstEndedAtMs[id] ?? now;
          else if (entry.job.active) { delete firstEndedAtMs[id]; entry.firstEnded = undefined; }
        } catch { entry.job = { ...entry.job, detailsUnavailable: true }; entry.nextCheck = now + 5000; }
      }
      if (hydrated) planned = plan(current);
      const compose = (latest: CodexLiveState, selection?: ReturnType<typeof plan>): CodexLiveState => {
        diagnostics?.onCompose();
        if (sessionChanged && latest.sessionId !== currentSession) latest = current;
        const { visibility, selectedId, retained, retainedSessions, retainedIds, detailedIds, turnCounts } = selection ?? plan(latest);
        const jobs = newest.filter(entry => retainedIds.has(entry.job.id)).map(entry => {
          if (!detailedIds.has(entry.job.id)) return entry.job;
          if (!entry.full && entry.raw) entry.full = jobView(entry.raw, entry.marker);
          return entry.full ? { ...entry.full, detailsUnavailable: entry.job.detailsUnavailable, lastUpdateMs: entry.job.lastUpdateMs } : entry.job;
        });
        const active = retained.some(session => session.active);
        const stale = jobs.some(job => job.detailsUnavailable);
        const nowMs = active || stale ? Math.floor(now / 5000) * 5000 : latest.nowMs;
        const candidate: CodexLiveState = boundState({ ...latest, jobs, selectedId, nowMs, sessionId: currentSession, turnCounts,
          spinnerTick: active && (paneOpen || newlyActive.length) ? Math.floor(now / 1000) : latest.spinnerTick,
          feeds: visibility.feeds && Object.fromEntries(Object.entries(visibility.feeds).filter(([id]) => retainedSessions.has(id))),
          viewedSessionIds: visibility.viewedSessionIds,
          newSessionIds: [...new Set([...(visibility.newSessionIds ?? []),
            ...retained.filter(session => session.turns.some(job => newlyActive.includes(job.id)) &&
              !visibility.viewedSessionIds?.includes(session.id)).map(session => session.id)])]
            .filter(id => retainedSessions.has(id) && id !== selectedId),
          seenJobIds: [...seen], autoOpenedJobIds: [...opened], firstEndedAtMs,
          recentEndedIds: recentEndedJobIds(retained, now, job => {
            const end = Date.parse(job.completedAt);
            const latestId = sessionForId(retained, job.id)!.turns.at(-1)!.id;
            return Number.isFinite(end) ? end : firstEndedAtMs[latestId] ?? NaN;
          }),
        });
        // Only the selected transcript is laid out. Other stopped windows keep
        // their small content anchors/snapshots until selected again.
        const selected = selectedJob(candidate);
        const feed = selectedId ? candidate.feeds?.[selectedId] : undefined;
        if (selected && feed) {
          const measured = viewports.get(feed.surface ?? 'terminal');
          const columns = measured?.columns ?? feed.columns;
          const rows = measured ? paneLayout(candidate, selected, measured.bodyRows).rows : feed.rows ?? 8;
          if (columns) candidate.feeds = { ...candidate.feeds, [selected.id]: normalizeFeed(feedLines(selected, nowMs, columns, feed), rows, { ...feed, columns }) };
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
      for (const entry of remembered) if (retainedIds.has(entry.job.id)) {
        cache.set(entry.job.id, entry);
        evicted.delete(entry.markerName);
        markerNames.add(entry.markerName);
        retryMarker.delete(entry.markerName);
      }
      for (const [id, entry] of cache) if (!retainedIds.has(id)) {
        if (!presentMarkers || presentMarkers.has(entry.markerName)) evicted.set(entry.markerName, {
          job: jobSummary(entry.job), processedMtime: entry.processedMtime, marker: entry.marker,
        });
        cache.delete(id);
        markerNames.delete(entry.markerName);
        retryMarker.set(entry.markerName, now + 10000); // Eviction is not a permanent "seen" tombstone.
      }
      const status = statusLine(candidate.jobs);
      if (status !== lastStatus) { $.ui.status(status); lastStatus = status; }
      if (newlyActive.length) await $.ui.open({ id: 'codex-live', title: 'Codex' });
    } catch (error) { reportFailure($, error); }
    finally { busy = false; }
  };
}
