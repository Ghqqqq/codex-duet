import { atom, read } from 'claude-code';
import type { EngineInterface } from 'claude-code';
import type { CodexLiveJob, CodexLiveMarker, CodexLiveState } from '../types';
import { boundState, jobSummary, jobView, markerView, statusLine, unavailableJob } from './model';
import { feedLines, headerLayout, normalizeFeed, recentEndedJobIds } from './layout';
import { reportFailure, updateFailure, viewports, writeView } from './runtime';

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

export function createPoller($: EngineInterface): (force?: boolean) => Promise<void> {
  let busy = false;
  let tick = 0;
  let session = '';
  let home = '';
  let canonical = false;
  let lastStatus: string | undefined;
  const cache = new Map<string, Cached>();
  const markerNames = new Set<string>();
  const retryMarker = new Map<string, number>();

  return async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      tick++;
      let current = await read($, view);
      const paneOpen = (await $.ui.panes()).some(pane => pane.id === 'codex-live');
      if (!force && !current.jobs.some(job => job.active) && !paneOpen && tick % 5 !== 1) return;
      const now = await $.clock.now();
      const currentSession = await $.session.id();
      const sessionChanged = !!current.sessionId && current.sessionId !== currentSession;
      if (session !== currentSession) {
        session = currentSession;
        cache.clear(); markerNames.clear(); retryMarker.clear();
      }
      if (sessionChanged) current = { jobs: [], selectedId: null, nowMs: 0 };
      const seen = new Set(current.seenJobIds ?? current.jobs.map(job => job.id));
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
      const entries = await $.fs.list(folder).catch(() => []);
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json') || markerNames.has(entry.name) || now < (retryMarker.get(entry.name) ?? 0)) continue;
        try {
          const marker = markerView(JSON.parse(await $.fs.read(`${folder}/${entry.name}`)));
          const previous = current.jobs.find(job => job.id === marker.jobId);
          if (!cache.has(marker.jobId)) cache.set(marker.jobId, {
            marker, markerName: entry.name, job: previous ? jobSummary(previous) : unavailableJob(marker),
            full: previous?.detailsLoaded !== false ? previous : undefined, nextCheck: 0,
          });
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
      const newest = [...cache.values(), ...restored].sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || b.job.id.localeCompare(a.job.id));
      const preferred = newest.find(entry => newlyActive.includes(entry.job.id))?.job.id;
      for (const id of newlyActive) opened.add(id);
      let retainedIds = new Set<string>();
      const compose = (latest: CodexLiveState): CodexLiveState => {
        if (sessionChanged) latest = current;
        const selectedId = preferred ?? (newest.some(entry => entry.job.id === latest.selectedId) ? latest.selectedId
          : newest.find(entry => entry.job.active)?.job.id ?? newest[0]?.job.id ?? null);
        const retained = newest.filter((entry, i) => i < 20 || entry.job.active || entry.job.id === selectedId);
        retainedIds = new Set(retained.map(entry => entry.job.id));
        const jobs = retained.map(entry => {
          if (entry.job.id !== selectedId) return entry.job;
          if (!entry.full && entry.raw) entry.full = jobView(entry.raw, entry.marker);
          return entry.full ? { ...entry.full, detailsUnavailable: entry.job.detailsUnavailable, lastUpdateMs: entry.job.lastUpdateMs } : entry.job;
        });
        const active = jobs.some(job => job.active);
        const stale = jobs.some(job => job.detailsUnavailable);
        const nowMs = active || stale ? Math.floor(now / 5000) * 5000 : latest.nowMs;
        const candidate: CodexLiveState = boundState({ ...latest, jobs, selectedId, nowMs, sessionId: currentSession,
          spinnerTick: active && (paneOpen || newlyActive.length) ? Math.floor(now / 1000) : latest.spinnerTick,
          feeds: latest.feeds && Object.fromEntries(Object.entries(latest.feeds).filter(([id]) => retainedIds.has(id))),
          seenJobIds: [...seen], autoOpenedJobIds: [...opened], firstEndedAtMs,
          recentEndedIds: recentEndedJobIds(jobs, now, job => {
            const end = Date.parse(job.completedAt);
            return Number.isFinite(end) ? end : firstEndedAtMs[job.id] ?? NaN;
          }),
        });
        // Only the selected transcript is laid out. Other stopped windows keep
        // their small content anchors/snapshots until selected again.
        const selected = candidate.jobs.find(job => job.id === selectedId);
        const feed = selectedId ? candidate.feeds?.[selectedId] : undefined;
        if (selected && feed) {
          const measured = viewports.get(feed.surface ?? 'terminal');
          const columns = measured?.columns ?? feed.columns;
          const rows = measured ? Math.max(0, measured.bodyRows - headerLayout(candidate, selected, measured.bodyRows).rows - 1) : feed.rows ?? 8;
          if (columns) candidate.feeds = { ...candidate.feeds, [selected.id]: normalizeFeed(feedLines(selected, nowMs, columns), rows, { ...feed, columns }) };
        }
        return candidate;
      };
      const candidate = compose(current);
      let saved = true;
      if (JSON.stringify(candidate) !== JSON.stringify(current) || updateFailure()) saved = await writeView($, compose);
      if (!saved) return;
      for (const [id, entry] of cache) if (!retainedIds.has(id)) {
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
