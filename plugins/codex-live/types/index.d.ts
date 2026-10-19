export type CodexLiveMarker = {
  jobId: string;
  jobFile: string;
  summary: string;
  title: string;
  name?: string;
  createdAt: string;
  workspaceRoot?: string;
};

export type CodexLiveEvent = {
  seq: number;
  at?: string;
  type: string;
  status?: string;
  lifecycle?: string;
  text?: string;
  body?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  path?: string;
  kind?: string;
  added?: number;
  removed?: number;
  server?: string;
  tool?: string;
  steps?: string[];
  statuses?: ('pending' | 'inProgress' | 'completed')[];
};

export type CodexLiveJob = {
  id: string;
  label: string;
  agentName?: string;
  status: string;
  active: boolean;
  finished: boolean;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  model: string;
  effort: string;
  fast: boolean;
  sandbox: string;
  workspaceRoot?: string;
  question: { text: string; options: string[] } | null;
  finalStatus: string;
  fileCount: number | null;
  events: CodexLiveEvent[];
  detailsUnavailable: boolean;
  detailsLoaded?: boolean;
  toolUses?: number;
  lastUpdateMs?: number;
};

export type CodexLiveFeedView = {
  feedOffset: number;
  following: boolean;
  seenLines: number;
  // Originating surface measurements; content anchors survive different wrapping.
  columns?: number;
  rows?: number;
  surface?: string;
  anchor?: { source: string; offset: number };
  seenItems?: Record<string, { length: number; hash: number }>;
};

export type CodexLiveState = {
  jobs: CodexLiveJob[];
  selectedId: string | null;
  nowMs: number;
  // Optional so a persisted view from an older plugin still follows the end.
  feeds?: Record<string, CodexLiveFeedView>;
  jobsExpanded?: boolean;
  hiddenJobIds?: string[];
  // Clear time in epoch milliseconds, including finished jobs outside the cache.
  hiddenFinishedBefore?: number;
  spinnerTick?: number;
  // Eligibility is computed by the poller; lifecycle metadata survives reloads.
  recentEndedIds?: string[];
  sessionId?: string;
  seenJobIds?: string[];
  autoOpenedJobIds?: string[];
  firstEndedAtMs?: Record<string, number>;
  historyPage?: number;
};

declare module 'claude-code' {
  interface PluginState {
    'codex-live': { view: CodexLiveState };
  }
}
