export type CodexLiveMarker = {
  jobId: string;
  jobFile: string;
  summary: string;
  title: string;
  name?: string;
  createdAt: string;
  workspaceRoot?: string;
};

// Published by the native adapter; this is navigation metadata, never ownership.
export type CodexNativeActivity = {
  jobId: string;
  threadId: string;
  workspace: string;
  name: string;
  model: string;
  models?: Record<string, string>;
};

export type CodexLiveUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
export type CodexLiveUsageEntry = { model: string; usage: CodexLiveUsage; sessionId?: string };

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
  questionText?: string;
  answer?: string;
  steps?: string[];
  statuses?: ('pending' | 'inProgress' | 'completed')[];
};

export type CodexLiveJob = {
  id: string;
  threadId?: string;
  label: string;
  agentName?: string;
  role?: string;
  homeDir?: string;
  cwd?: string;
  status: string;
  active: boolean;
  finished: boolean;
  unresolved?: boolean;
  notStarted?: boolean;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  model: string;
  usage?: CodexLiveUsage;
  effort: string;
  fast: boolean;
  sandbox: string;
  workspaceRoot?: string;
  question: { text: string; options: string[]; createdAt?: string; expiresAt?: number } | null;
  // A finished needs_input report, separate from an active pending question.
  terminalQuestion?: string;
  // Only detailed turns retain the bounded Claude brief.
  prompt?: string;
  promptReport?: boolean;
  // Bounded display summaries survive when transcript details are omitted.
  currentOperation?: string;
  lastActivityAt?: string;
  finalStatus: string;
  blockerCode?: string;
  fileCount: number | null;
  events: CodexLiveEvent[];
  detailsUnavailable: boolean;
  detailsLoaded?: boolean;
  // An older retained turn intentionally has a header but no transcript.
  detailsOmitted?: boolean;
  toolUses?: number;
  lastUpdateMs?: number;
};

// Derived from flat persisted jobs; live/unresolved owners outrank later refusals.
export type CodexLiveSession = CodexLiveJob & { turns: CodexLiveJob[]; turnCount: number; lifecycleJobId: string;
  sessionUsage?: Record<string, CodexLiveUsageEntry>; usagePartial?: boolean };

export type CodexLiveFeedView = {
  feedOffset: number;
  following: boolean;
  // Bulk expansion stays stopped through reflow until a person scrolls/toggles.
  keepStopped?: boolean;
  seenLines: number;
  // Worker turn IDs, or post:<seq> IDs in a forum:<roomId> feed (at most 5000).
  expandedPromptIds?: string[];
  // Originating surface measurements; content anchors survive different wrapping.
  columns?: number;
  rows?: number;
  surface?: string;
  anchor?: { source: string; offset: number };
  seenItems?: Record<string, { length: number; hash: number }>;
};

export type ForumPost = {
  seq: number;
  at: string;
  initial?: boolean;
  author: { kind: string; name: string };
  kind: 'idea' | 'finding' | 'question' | 'request' | 'intent' | 'candidate' | 'decision';
  thread: number;
  replyTo: number | null;
  title: string;
  body: string;
  label: string;
  refs: string[];
  mentions: string[];
};
export type ForumRoom = {
  roomId: string;
  sessionId: string;
  goal: string;
  status: 'open' | 'paused' | 'closed';
  intensity: string;
  members: string[];
  createdAt: string;
  postCount: number;
  viewedPosts?: number;
  posts?: ForumPost[];
  // Positive member timestamps; negative chair-decision timestamps.
  timeline?: number[];
  malformed?: number;
  omitted?: number;
  warning?: string;
};

export type CodexLiveState = {
  forumRooms?: ForumRoom[];
  jobs: CodexLiveJob[];
  // Thread session ID, or a legacy/unthreaded job ID.
  selectedId: string | null;
  // Explicit navigation can reveal one job hidden by Clear finished.
  openedJobId?: string;
  // Conversation discovery is separate from selection/read acknowledgement.
  newSessionIds?: string[];
  viewedSessionIds?: string[];
  nowMs: number;
  // Total observed turns, including turns omitted from the bounded view.
  turnCounts?: Record<string, number>;
  // Optional so a persisted view from an older plugin still follows the end.
  feeds?: Record<string, CodexLiveFeedView>;
  jobsExpanded?: boolean;
  hiddenJobIds?: string[];
  // Closed-room tombstones; explicit selection can still reveal one room.
  hiddenRoomIds?: string[];
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
  // Discovery health is independent of an individually readable cached job.
  discoveryWarning?: string;
  // Uncleared terminal attention outside the retention/state budgets.
  attentionOmitted?: number;
  // Per-turn snapshots keyed by job, replaced rather than accumulated on polls.
  usageByJob?: Record<string, CodexLiveUsageEntry>;
  usagePartial?: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'fugato-live': { view: CodexLiveState };
    fugato: { nativeAgents: Record<string, CodexNativeActivity> };
  }
}
