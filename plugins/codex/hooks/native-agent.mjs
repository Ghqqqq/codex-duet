// Native adapter for the early-access Claude Code 2.1.302 function-hook API.
// No Node globals/imports in this sandbox; all host work goes through $.
import { TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES } from '../scripts/lib/agent-name-pool.mjs';
export const AGENT_TYPE = 'codex:codex-native';
const PREFIX = 'native:v2:';
const ACTIVE = ['queued', 'running'];
const WAIT_TIMEOUT_SEC = '3600';
const HEARTBEAT_MS = 30000;
const EARLY_HANDLES_MS = 1500;
const READY = 'Native Codex workers ready: Agent(subagent_type: "codex:codex-native", prompt) — optional first line "DUET: <flags>"; SendMessage to continue or answer; stop from /tasks; live progress shows inside the agent and in codex-live.';
const GUIDE_ID = 'codex:native-dispatch';
const NATIVE_GUIDE = 'Native Codex workers are ready. Dispatch Codex with Agent(subagent_type: "codex:codex-native", prompt: "<brief>") (the plugin assigns a scientist name, replacing a passed label unless it is a free pool name; the assigned name appears in the Agent result); an optional first prompt line DUET: --model <model> --effort <effort> --sandbox <mode> --fast|--normal --fork --cwd <dir> sets task flags. The agent result is the Duet report; continue a worker or answer its question with SendMessage. Browser work and Computer Use run natively: an app not yet approved arrives as an approval question answered through SendMessage. Use background-Bash duet task only when the agent reports native_adapter_unavailable or native_capacity, a dispatch needs a per-call override the DUET line rejects (--run, --approve-browser-origin, --approve-computer-app, --lease-sec, --question-timeout-sec), or you follow up a worker that Bash launched.';
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk'];
// Final statuses whose Codex turn is known to have ended. Interrupted,
// cancelled and failed jobs need a confirmed cancellation instead.
const ENDED = ['completed', 'needs_input', 'blocked'];
const CLOSED = 'native:closed:v1:';
const BINDING_FAILED = 'native:binding-failed:v1:';
// Mirror state.mjs unresolvedTask's failed-result rule. A failed transport
// without a confirmed end may still own its turn; a worker failure has ended.
const failedEnded = job => job.status === 'failed' && (job.recovered || (job.result
  && (job.result.turnEnded || job.result.structured || (job.result.failureSource !== 'transport'
    && (job.result.workerStatus || (job.result.errorCode !== 'BROKER_CONNECTION_CLOSED'
      && !/^(Codex broker connection closed during startup\.|Connection to Codex closed while the turn was running\.|Codex connection closed before turn completion; recover the recorded job\.)$/i.test(job.result.error ?? job.errorMessage ?? '')))))));
const ended = (job, state) => ENDED.includes(job.status)
  || failedEnded(job)
  || (['interrupted', 'cancelled'].includes(job.status) && job.interruptionConfirmed === true)
  || (state.cancellation?.confirmation === 'confirmed' && state.cancellation.jobId === job.id);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 128, MAX_STORE_SIZE = 2 * 1024 * 1024;
const stateSize = state => JSON.stringify(state ?? null).length * 4;
const finished = state => state?.finishedAt && !state.incoming
  && state.status !== 'needs_answer' && state.answer?.status !== 'needs_answer';
const ALLOWED = '--model, --effort, --sandbox, --fast/--normal, --cwd, --fork';
const startedTypes = new Map();
const knownTypes = new Map();
// Display only: an entry exists only while this module owns a live flight.
const liveProgress = new Map();
const toolAgents = new Map(), agentDisplays = new Map();
const promptTurns = new Map(), turnPrompts = new Map(), turnLogs = new Map();
const logKey = (agentId, turnId) => JSON.stringify([agentId, turnId]);
const invalidateProgress = $ => {
  try { $.ui.invalidate('ui.render'); } catch { /* Display must never affect a turn. */ }
};
function rememberDisplay(map, id, value) {
  map.delete(id); map.set(id, value);
  if (map.size > 256) {
    // Short finished jobs must not evict the row of an older live agent.
    const oldest = [...map.keys()].find(key => {
      if (key === id) return false;
      const value = map.get(key);
      if (map === turnLogs) return liveProgress.get(value.agentId) !== value;
      if (map === promptTurns || map === turnPrompts) return liveProgress.get(value.agentId)?.turnId !== value.turnId;
      return !liveProgress.has(map === toolAgents ? value : key);
    }) ?? map.keys().next().value;
    map.delete(oldest);
    if (map === agentDisplays) for (const [key, log] of turnLogs) {
      if (log.agentId === oldest) turnLogs.delete(key);
    }
  }
}
function bindPrompt($, turn) {
  if (turn.uuid) return;
  // Append may precede or follow turn.start. Consume each row and turn once,
  // in order within its own agent; identical later briefs keep separate logs.
  // A SendMessage follow-up is stored with the host's framing around the
  // text turn.start received ("The coordinator sent a message …"). Prefer an
  // exact row; otherwise take the newest unbound row that frames this text.
  let match = null;
  for (const [uuid, row] of promptTurns) {
    if (row.turnId || row.agentId !== turn.agentId || typeof row.text !== 'string') continue;
    if (row.text === turn.text) { match = uuid; break; }
    if (turn.text && row.text.includes(turn.text)) match = uuid;
  }
  if (match) {
    const row = promptTurns.get(match);
    row.turnId = turn.turnId; turn.uuid = match;
    delete row.text; delete turn.text;
    invalidateProgress($);
  }
}
function rememberPrompt($, e) {
  if (typeof e.text !== 'string' || e.text.length > 65536) return;
  const key = logKey(e.agentId, e.turnId);
  if (turnPrompts.has(key)) return;
  const turn = { agentId: e.agentId, turnId: e.turnId, text: e.text.trim() };
  rememberDisplay(turnPrompts, key, turn);
  bindPrompt($, turn);
}
function updateDisplay($, state, job) {
  const view = agentDisplays.get(state.agentId);
  if (!view || !liveProgress.has(state.agentId) || view.turnId !== (state.incoming?.turnId ?? state.intent?.turnId)) return;
  view.name = state.worker || state.name || view.name;
  if (typeof state.effort === 'string') view.effort = state.effort;
  if (job) {
    const request = job.request;
    if (typeof request?.model === 'string') view.model = request.model;
    if (typeof request?.effort === 'string') view.effort = request.effort;
    if (request && Object.hasOwn(request, 'serviceTier')) view.speed = request.serviceTier === 'priority' ? 'fast' : 'normal';
    view.question = ACTIVE.includes(job.status) && job.pendingQuestion?.answer === undefined
      && typeof job.pendingQuestion?.text === 'string' ? job.pendingQuestion.text.slice(0, 200) : undefined;
  }
  invalidateProgress($);
}
const elapsedDisplay = ms => {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const commandStart = text => /^▸/.test(text) || /^Bash\(.*\) · running\s*$/.test(text);
const resultStyle = result => /^Done\b/.test(result) ? { color: 'success' }
  : /^(?:Error|Failed|Blocked)\b/.test(result) ? { color: 'error' } : { dimColor: true };
function logEntry(text) {
  if (/^Codex worker .+ running · /.test(text)) return null;
  if (text.startsWith('Codex:')) return { kind: 'message', title: text.slice(6).trim() };
  if (/^Codex worker .+ started · /.test(text)) return { kind: 'info', title: text };
  const event = (title, result) => ({ kind: 'event', title, result, running: result === 'running' });
  let match;
  if ((match = /^(Bash\(.*\)|(?:Update|Write|Delete)\(.*\)) · (.*)$/.exec(text))) return event(match[1], match[2]);
  if ((match = /^Update Todos · (.*)$/.exec(text))) return event('Update Todos', match[1]);
  if ((match = /^(.+) · (running|Done(?:\s.*)?|Error(?:\b.*)|Failed(?:\b.*)|Blocked(?:\b.*)|exit unknown|cancelled|declined|interrupted)$/.exec(text))) return event(match[1], match[2]);
  if ((match = /^▸\s*(.*)$/.exec(text))) return event(`Bash(${match[1]})`, 'running');
  if ((match = /^([✓✗]) exit (-?\d+)(?: · (\d+(?:\.\d+)?s))? · (.*)$/.exec(text))) {
    return event(`Bash(${match[4]})`, (match[1] === '✓' ? 'Done' : `Error: exit ${match[2]}`) + (match[3] ? ` (${match[3]})` : ''));
  }
  if ((match = /^(?:■ (cancelled|declined|interrupted)|\? (exit unknown)) · (.*)$/.exec(text))) return event(`Bash(${match[3]})`, match[1] || match[2]);
  if ((match = /^edit (.+) (\+[\d?]+ [−-][\d?]+)$/.exec(text))) return event(`Update(${match[1]})`, match[2]);
  if ((match = /^plan (.*)$/.exec(text))) return event('Update Todos', match[1]);
  if ((match = /^Tool (.+): (\w+)(?: \((.*)\))?$/.exec(text))) {
    const status = ['started', 'inProgress', 'running', 'queued'].includes(match[2]) ? 'running'
      : ['completed', 'success'].includes(match[2]) ? 'Done' : ['failed', 'error'].includes(match[2]) ? 'Error' : match[2];
    return event(match[1], status + (status !== 'running' && match[3] ? ` (${match[3]})` : ''));
  }
  if ((match = /^([✓✗])\s*(.*)$/.exec(text))) return event(match[2], match[1] === '✓' ? 'Done' : 'Error');
  return { kind: 'info', title: text };
}
function appendLog($, log, text) {
  try {
    const entry = logEntry(text);
    if (!entry) return;
    // Identical commands may overlap. Match their completions FIFO, as Codex
    // reports same-title completions in order; never dedupe a running start or
    // a completion that still has a running entry to consume.
    const running = entry.kind === 'event' && !entry.running
      ? log.entries.findIndex(item => item.running && item.title === entry.title) : -1;
    if (!entry.running && running < 0 && log.last === text) return;
    log.last = text;
    if (running >= 0) log.entries[running] = entry;
    else {
      log.entries.push(entry);
      if (log.entries.length > 40) { log.entries.shift(); log.omitted++; }
    }
    invalidateProgress($);
  } catch { /* The display log must never affect progress delivery. */ }
}
const entryText = entry => entry.kind === 'event' ? `${entry.title} · ${entry.result}`
  : entry.kind === 'message' ? `Codex: ${entry.title}` : entry.title;
const entryStyle = entry => entry.kind === 'event' ? resultStyle(entry.result)
  : entry.kind === 'message' ? { color: 'text' } : { dimColor: true };
function lineStyle(text) {
  if (/^Codex:/.test(text)) return { color: 'text' };
  if (/^✗/.test(text)) return { color: 'error' };
  if (/^✓/.test(text)) return { color: 'success' };
  if (/^▸/.test(text)) return { dimColor: true };
  // A command mentioning "Failed" still takes the color of its own outcome.
  const status = text.startsWith('Bash(') && text.includes(') · ') ? text.slice(text.lastIndexOf(') · ') + 2) : text;
  return /· Done\b/.test(status) ? { color: 'success' }
    : /· Error\b|\b(?:Failed|Blocked)\b/.test(status) ? { color: 'error' } : { dimColor: true };
}
const displayWidth = e => Number.isFinite(e.viewport?.columns) ? Math.max(0, Math.floor(e.viewport.columns)) : 120;
const displayRow = (e, children, props = {}) => ({ type: 'Box', props: {
  width: displayWidth(e)
}, children: [{ type: 'Text', props: { wrap: 'truncate-end', ...props }, children }] });
const progressRow = (e, text, prefix = '') => displayRow(e, [prefix + text.replace(/\s+/g, ' ')], lineStyle(text));
function logRows(e, entry) {
  let rows;
  if (entry.kind === 'message') {
    const chars = Array.from(entry.title.replace(/\s+/g, ' ')), width = Math.max(1, displayWidth(e) - 2);
    rows = [];
    while (chars.length && rows.length < 3) {
      let count = 0, cells = 0;
      // Budget non-Latin glyphs conservatively; the host clips each row in
      // terminal cells. Explicit rows keep commentary to three at any width.
      while (count < chars.length) {
        const size = chars[count].codePointAt(0) > 255 ? 2 : 1;
        if (cells + size > width) break;
        cells += size; count++;
      }
      count = Math.max(1, count);
      const space = chars.slice(0, count).lastIndexOf(' ');
      if (space > 0 && count < chars.length) count = space + 1;
      const text = chars.splice(0, count).join('').trimEnd();
      rows.push(displayRow(e, [(rows.length ? '  ' : '● ') + text + (rows.length === 2 && chars.length ? '…' : '')], { color: 'text' }));
    }
  } else if (entry.kind === 'event') rows = [
    displayRow(e, [`● ${entry.title}`], { bold: true, color: 'text' }),
    displayRow(e, [`  ⎿ ${entry.running ? 'Running…' : entry.result}`], entryStyle(entry))
  ];
  else rows = [displayRow(e, [entry.title], { dimColor: true })];
  return { type: 'Box', props: { flexDirection: 'column' }, children: rows };
}
const displayStatus = status => ({ completed: 'Done', blocked: 'Blocked', failed: 'Failed',
  needs_answer: 'Needs answer', needs_input: 'Needs answer', interrupted: 'Interrupted',
  cancelled: 'Interrupted', owner_stopped: 'Interrupted', ownership_moved: 'Interrupted' })[status] || 'Failed';
function promptDisplay(text) {
  if (typeof text !== 'string' || !text.startsWith('DUET: ')) return null;
  const { brief, flags, cwd } = parsePrompt(text);
  const value = flag => {
    const index = flags.indexOf(flag);
    return index < 0 ? undefined : flags[index + 1];
  };
  // Show only supplied settings; defaults and inherited settings are not known
  // from the prompt. Keep the brief byte-for-byte as parsePrompt received it.
  const parts = ['Codex', value('--model'), value('--effort'),
    flags.includes('--fast') ? 'fast' : flags.includes('--normal') ? 'normal' : undefined,
    value('--sandbox'), flags.includes('--fork') ? 'fork' : undefined,
    cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || cwd];
  return { text: brief, header: parts.filter(Boolean).map(part => part.replace(/\s+/g, ' ')).join(' · ') };
}
const keyFor = (session, id) => `${PREFIX}${session}:${id}`;
const closedKey = (session, id) => `${CLOSED}${session}:${id}`;
const bindingFailedKey = (session, id) => `${BINDING_FAILED}${session}:${id}`;
const nonceFor = (session, agent, turn) => [session, agent, turn].map(encodeURIComponent).join(':');
const nativeNext = (state, status, blockers = []) => {
  const blocker = status === 'blocked' && blockers.find(blocker =>
    ['context_window_exceeded', 'provider_refused', 'auth_required'].includes(blocker.code));
  if (blocker?.code === 'context_window_exceeded') return 'Start a new native agent with a shorter brief.';
  if (blocker?.code === 'provider_refused') return 'Start a new native agent with a reworded brief.';
  if (blocker?.code === 'auth_required') return 'Run /codex:setup, then start a new native agent.';
  return `SendMessage to ${state.name || state.agentId} ${status === 'needs_answer' ? 'with the answer' : 'to continue'}`;
};
// Catch next is replay-safe (d.ts 1211-1213), even after a successful spawn.
function passthrough($, e, next) { return next(e); }
// Count the UTF-8 bytes of JSON string content, including escaped controls and
// lone surrogates. Iterate code points so truncation never splits a pair.
function boundedText(value, budget) {
  let text = '', bytes = 0;
  for (const char of String(value)) {
    const encoded = JSON.stringify(char).slice(1, -1);
    let size = 0;
    for (const point of encoded) { const n = point.codePointAt(0); size += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
    if (bytes + size > budget) break;
    text += char; bytes += size;
  }
  return text;
}
// Active and unresolved recovery reports are consumed before native completion.
const RECOVERY_STATUSES = ['unknown', 'unreachable'];
const REPORT_STATUSES = new Set([...ACTIVE, ...RECOVERY_STATUSES, 'completed', 'needs_input', 'needs_answer', 'blocked',
  'failed', 'interrupted', 'cancelled', 'owner_stopped', 'ownership_moved']);
const REPORT_FIELDS = new Set(['status', 'worker', 'jobId', 'summary', 'summaryTruncated', 'blockers',
  'question', 'changedFiles', 'checks', 'assumptions', 'keyFindings', 'usage', 'next', 'details', 'notice',
  'changedFilesOmitted', 'keyFindingsOmitted', 'assumptionsOmitted', 'blockersOmitted',
  'verificationOmitted', 'claimedVerificationOmitted', 'touchedFilesOmitted', 'preExistingChangesOmitted',
  'approvedBrowserOriginsOmitted', 'approvedComputerAppsOmitted']);
function reportMarkdown(props) {
  if (Object.hasOwn(props, 'isSummary') || typeof props.text !== 'string') return null;
  let report;
  try { report = JSON.parse(props.text.trim()); } catch { return null; }
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).some(key => !REPORT_FIELDS.has(key))
    || !REPORT_STATUSES.has(report.status) || ACTIVE.includes(report.status) || RECOVERY_STATUSES.includes(report.status)
    || !(report.worker === null || typeof report.worker === 'string')
    || !(report.next === null || (typeof report.next === 'string' && (report.next.startsWith('SendMessage to ')
      || (Array.isArray(report.blockers) && (report.next === nativeNext({}, report.status, report.blockers)
        || report.blockers.some(blocker => ['native_capacity', 'native_binding_gone', 'native_message_too_large'].includes(blocker?.code)
          && report.next === admissionBlocked(blocker.code, {}).next))))))
    || !(report.notice === undefined || typeof report.notice === 'string')
    || !(report.details === null || (typeof report.details === 'string' && report.details.startsWith('duet result ')))
    || !((typeof report.jobId === 'string' && /^(task|review|job)-/.test(report.jobId))
      || (Array.isArray(report.blockers) && report.blockers.length > 0
        && report.blockers.every(blocker => typeof blocker?.code === 'string' && blocker.code.startsWith('native_'))))) return null;
  const clip = text => {
    const value = boundedText(text, 600);
    return value === text ? value : `${value}…`;
  };
  const plain = value => typeof value === 'string'
    ? clip(value.replace(/\s+/g, ' ').trim()).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&') : '';
  const lines = [`**${plain(report.worker) || 'Codex'}** · ${report.status} · job ${plain(report.jobId) || '—'}`];
  if (typeof report.summary === 'string' && report.summary.trim()) {
    const summary = report.summary.trim().split(/\r\n?|\n|\u2028|\u2029/);
    lines.push('', ...summary.slice(0, 12).map(clip));
    if (summary.length > 12) lines[lines.length - 1] = '…';
  }
  const list = (title, values) => {
    const items = Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
    if (!items.length) return;
    lines.push('', `**${title}**`, ...items.slice(0, 10).map(value => `- ${plain(value)}`));
    if (items.length > 10) lines.push('', `+${items.length - 10} more`);
  };
  list('Checks run', report.checks?.ran);
  list('Key findings', report.keyFindings);
  list('Blockers', Array.isArray(report.blockers) ? report.blockers
    .filter(blocker => typeof blocker?.code === 'string')
    .map(blocker => `${blocker.code}${typeof blocker.message === 'string' ? `: ${blocker.message}` : ''}`) : []);
  // Reserve the question and next action before trimming less urgent sections.
  const tail = [], question = typeof report.question === 'string' ? { text: report.question } : report.question;
  if (report.notice) tail.push('', plain(report.notice));
  if (question) {
    const options = Array.isArray(question.options) ? question.options.filter(option => typeof option === 'string') : [];
    tail.push('', '**Question**');
    if (typeof question.text === 'string') tail.push(plain(question.text));
    tail.push(...options.slice(0, 10).map(option => `- ${plain(option)}`));
    const omitted = Math.max(0, options.length - 10)
      + (Number.isSafeInteger(question.optionsOmitted) && question.optionsOmitted > 0 ? question.optionsOmitted : 0);
    if (omitted) tail.push('', `+${omitted} more`);
  }
  const usage = [['inputTokens', 'input'], ['cachedInputTokens', 'cached'], ['outputTokens', 'output'],
    ['reasoningOutputTokens', 'reasoning'], ['totalTokens', 'total']]
    .filter(([key]) => Number.isSafeInteger(report.usage?.[key]) && report.usage[key] >= 0)
    .map(([key, label]) => `${report.usage[key]} ${label}`);
  if (usage.length) tail.push('', `Usage: ${usage.join(' · ')} tokens`);
  if (report.next) tail.push('', plain(report.next));
  // At most 60 lines, including all section/omission spacing and the next action.
  return [...(lines.length + tail.length > 60 ? [...lines.slice(0, 59 - tail.length), '…'] : lines), ...tail].join('\n');
}
// Details name the exact job: a worker name moves to its newest job after a follow-up.
const nativeDetails = state => state.jobId ? `duet result '${state.jobId}' --details` : state.worker ? `duet result ${state.worker} --details` : null;
function blocked(message, state = {}, code = 'native_adapter_error') {
  const summary = boundedText(message, 1200);
  return { status: 'blocked', worker: state.worker || null, jobId: state.jobId || null, summary,
    blockers: [{ code, message: summary }], next: nativeNext(state, 'blocked'),
    details: nativeDetails(state) };
}

async function ours($, id) {
  if (!id) return null;
  const session = await $.session.id(), key = keyFor(session, id);
  const startedType = startedTypes.get(key);
  if (startedType && startedType !== AGENT_TYPE) return null;
  let row;
  try { row = (await $.agent.list()).find(agent => agent.id === id); }
  catch { /* SubagentStart identifies even a first turn during list outages. */ }
  if (row) { knownTypes.set(id, row.type); return row.type === AGENT_TYPE ? row : null; }
  // agent.spawn records the type as soon as the host returns the id; turn.start
  // can arrive before the list shows the agent, and it writes the store itself.
  if (startedType === AGENT_TYPE || knownTypes.get(id) === AGENT_TYPE) return { id };
  const state = await $.store.get(key);
  if (state?.type === AGENT_TYPE) return { id, name: state.name };
  return await $.store.get(bindingFailedKey(session, id)) ? { id } : null;
}

// A small argv tokenizer, never a shell. Quotes/backslashes allow cwd with spaces;
// command substitution, expansions and shell operators have no special meaning.
function parsePrompt(text) {
  if (!text.startsWith('DUET: ')) return { brief: text, flags: [] };
  const newline = text.indexOf('\n');
  const header = text.slice(6, newline < 0 ? undefined : newline).replace(/\r$/, '');
  const tokens = []; let token = '', quote = '', escaped = false, present = false;
  for (const char of header) {
    if (escaped) { token += char; escaped = false; present = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; present = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; present = true; }
    else if (/\s/.test(char)) { if (present) tokens.push(token); token = ''; present = false; }
    else { token += char; present = true; }
  }
  const invalid = () => { throw new Error(`Invalid DUET header. Allowed flags: ${ALLOWED}.`); };
  if (quote || escaped) invalid();
  if (present) tokens.push(token);
  const flags = [], seen = new Set(); let cwd;
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(--[a-z]+)(?:=(.*))?$/.exec(tokens[i]);
    if (!match) invalid();
    const [, flag, inline] = match;
    if (seen.has(flag)) invalid();
    seen.add(flag);
    if (['--fast', '--normal', '--fork'].includes(flag)) {
      if (inline !== undefined || (seen.has('--fast') && seen.has('--normal'))) invalid();
      flags.push(flag); continue;
    }
    if (!['--model', '--effort', '--sandbox', '--cwd'].includes(flag)) invalid();
    const value = inline ?? tokens[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) invalid();
    if (flag === '--cwd') cwd = value;
    else flags.push(flag, value);
  }
  return { brief: newline < 0 ? '' : text.slice(newline + 1), flags, cwd };
}

function admissionBlocked(code, state) {
  const [message, next] = code === 'native_capacity'
    ? ['Native adapter capacity is full; nothing was launched.', 'Wait for active workers to finish or stop them before starting a new native agent.']
    : code === 'native_message_too_large'
      ? ['Native message exceeds the adapter message limit; nothing was launched.', 'Start a new native agent with a shorter brief.']
      : ['The native agent binding is no longer retained; nothing was launched.', 'Start a new native agent.'];
  return { ...blocked(message, state, code), next };
}

const SPAWN_GRACE_MS = 10 * 60 * 1000;
// A reloaded module cannot tell a delayed first turn.start from an orphan, so
// orphan guards (tiny, still budgeted) are reclaimed only after a day.
const ORPHAN_GUARD_MS = 24 * 60 * 60 * 1000;
const unstartedSince = new Map();
// Keep the queues outside register(): re-registration must not forget writes
// that have already entered the host. A fresh module has its own queues.
let admission = Promise.resolve();
const bindingWrites = new Map();
const serializeAdmission = action => {
  const pending = admission.then(action);
  admission = pending.catch(() => {});
  return pending;
};
function writeBinding(key, action) {
  const pending = (bindingWrites.get(key) || Promise.resolve()).then(action);
  const settled = pending.catch(() => {}).finally(() => {
    if (bindingWrites.get(key) === settled) bindingWrites.delete(key);
  });
  bindingWrites.set(key, settled);
  return pending;
}
async function prune($, { reserveCount = 0, reserveSize = 0, keepKey, pending = () => false } = {}) {
  const now = await $.clock.now(), keys = await $.store.keys(), kept = new Set(), records = [];
  const unstarted = value => !value.v && !value.intent && !value.incoming && !value.finishedAt;
  const seen = new Set(keys), guards = new Map();
  for (const key of unstartedSince.keys()) if (!seen.has(key)) unstartedSince.delete(key);
  let count = 0, active = 0, size = 0, keepSize = 0;
  // Spawn may publish only its guard before a host/store failure. Such orphans
  // still consume store space; reclaim them after ORPHAN_GUARD_MS.
  for (const key of keys) if (key.startsWith(BINDING_FAILED)) {
    const value = await $.store.get(key);
    if (!value) continue;
    const primary = PREFIX + key.slice(BINDING_FAILED.length);
    if (primary !== keepKey && !dispatching.has(primary) && !pending(primary)
      && typeof value.at === 'number' && now - value.at >= ORPHAN_GUARD_MS
      && !await $.store.get(primary)) {
      const fresh = await $.store.get(key);
      if (fresh?.at === value.at && !dispatching.has(primary) && !pending(primary)) {
        await $.store.delete(key);
        continue;
      }
    }
    guards.set(key, stateSize(value)); size += stateSize(value);
  }
  for (const key of keys) {
    if (!key.startsWith(PREFIX)) continue;
    const state = await $.store.get(key);
    if (!state) { unstartedSince.delete(key); continue; }
    if (unstarted(state)) {
      if (!unstartedSince.has(key)) unstartedSince.set(key, now);
    } else unstartedSince.delete(key);
    records.push({ key, state });
    if (key === keepKey) keepSize = stateSize(state);
    count++; size += stateSize(state);
    if (!finished(state)) active++;
  }
  // History uses spare record slots, never admission slots. Reclaim oldest
  // finished bindings first, including enough room for the incoming record.
  records.sort((a, b) => (a.state.finishedAt || Infinity) - (b.state.finishedAt || Infinity));
  for (const record of records) {
    const { key } = record;
    let { state } = record;
    // finishedAt is certain except after an unconfirmed cancellation, whose
    // timestamp is age-retention evidence only. Legacy unstarted
    // bindings get a full observation window before yielding their slots.
    const expired = value => finished(value) && now - value.finishedAt > RETENTION_MS;
    const evictable = async value => {
      if (key === keepKey || dispatching.has(key) || pending(key)) return false;
      if (unstarted(value)) {
        if (!unstartedSince.has(key)) unstartedSince.set(key, now);
        if (now - unstartedSince.get(key) < SPAWN_GRACE_MS) return false;
      } else {
        unstartedSince.delete(key);
        if (!finished(value)) return false;
        if (!expired(value) && value.cancellation
          && !(value.cancellation?.confirmation === 'confirmed' && value.cancellation.jobId === value.jobId)
          && !await isClosed($, value)) return false;
      }
      const guard = await $.store.get(BINDING_FAILED + key.slice(PREFIX.length));
      return !(typeof guard?.at === 'number' && now - guard.at < SPAWN_GRACE_MS)
        && !pending(key) && !dispatching.has(key);
    };
    const needed = value => (!unstarted(value) && now - value.finishedAt > RETENTION_MS)
      || count + reserveCount > MAX_RECORDS || size + reserveSize > MAX_STORE_SIZE;
    if (needed(state) && await evictable(state)) {
      // A turn may have admitted a message or parked a question since the
      // inventory read. Recheck both eligibility and budgets before deleting.
      const fresh = await $.store.get(key);
      if (!fresh) { unstartedSince.delete(key); count--; size -= stateSize(state); continue; }
      size += stateSize(fresh) - stateSize(state);
      active += Number(!finished(fresh)) - Number(!finished(state));
      state = fresh;
      if (needed(state) && await evictable(state)) {
        await $.store.delete(key);
        unstartedSince.delete(key);
        if (state.agentId) {
          await $.store.delete(closedKey(state.session, state.agentId));
          const guard = bindingFailedKey(state.session, state.agentId);
          await $.store.delete(guard);
          size -= guards.get(guard) || 0; guards.delete(guard);
        }
        count--; size -= stateSize(state); active -= Number(!finished(state));
        continue;
      }
    }
    const marker = state?.agentId ? closedKey(state.session, state.agentId) : null;
    if (marker) kept.add(marker);
  }
  // A marker never expires before its state record; drop only old orphans.
  for (const key of keys) if (key.startsWith(CLOSED) && !kept.has(key)) {
    if (now - ((await $.store.get(key))?.at ?? 0) > RETENTION_MS) await $.store.delete(key);
  }
  return { count, active, size, keepSize };
}

// Module-local promises serialize overlapping steps; persisted intents cover
// reloads. The companion's locked nonce reservation also covers other copies.
const flights = new Map(), nodes = new Map(), dispatching = new Map();
async function node($, timeoutMs = 10000) {
  const session = await $.session.id();
  if (!nodes.has(session)) nodes.set(session, (async () => {
    // This API does not expose Claude's execPath (Claude may be bundled Bun).
    // Pin the same host PATH Node that the classic hooks and Bash path use.
    const result = await $.process.run(['node', '-p', 'process.execPath'], { timeoutMs });
    const executable = result.stdout.trim();
    if (result.exitCode !== 0 || !/^(\/|[A-Za-z]:[\\/])/.test(executable) || /[\r\n]/.test(executable)) throw new Error('Node.js is required for native Codex workers; no host Node executable was found.');
    return executable;
  })());
  try { return await nodes.get(session); }
  catch { nodes.delete(session); throw new Error('Node.js is required for native Codex workers; no host Node executable was found.'); }
}
async function processBudget($, { deadline, timeoutMs = 15000, reserveMs = 0 } = {}) {
  const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - await $.clock.now() - reserveMs);
  if (remaining < 1) throw new Error('Native stop confirmation deadline expired; inspect duet status.');
  return Math.floor(remaining);
}
async function command($, state, args, input = '', timing = {}) {
  // ProcessSpawnRequest.input writes the whole string and closes stdin (also
  // for an empty string). Do not use process.run's differently named stdin.
  return { argv: [await node($, timing.deadline === undefined ? 10000 : await processBudget($, { ...timing, timeoutMs: 500 })), `${$.plugin.root}/bin/duet`, ...args, '--cwd', state.cwd, '--session', state.session,
    ...(args[0] === 'task' ? ['--session-cwd', await $.session.root()] : [])], cwd: state.cwd, input };
}
async function companion($, state, args, input = '', progress) {
  let child;
  try { child = $.process.spawn(await command($, state, args, input)); }
  catch (error) {
    // No stream was obtained: Node resolution or the synchronous spawn failed
    // before the companion could run. Stream/pull failures remain ambiguous.
    error.launchNotStarted = true;
    throw error;
  }
  let stdout = '', stderr = '', line = '', overflow = false;
  // Pull BOTH pipes until EOF; result only settles after the final pull. Keep
  // one bounded partial line, plus the bounded report tail. Never show JSON or
  // stderr as progress. A slow consumer backpressures the host's bounded pipe.
  for await (const chunk of child) {
    if (chunk.stream === 'stderr') { stderr = (stderr + chunk.text).slice(-4096); continue; }
    if (chunk.stream === 'stdout') {
      stdout = (stdout + chunk.text).slice(-4 * 1024 * 1024);
      if (!progress) continue;
      for (const part of chunk.text.split(/(?<=\n)/)) {
        const end = part.endsWith('\n');
        if (!overflow) {
          line += part;
          if (line.length > 2048) { line = ''; overflow = true; }
        }
        if (end) {
          const text = line.trimEnd();
          if (!overflow && (/^\[\d+\] /.test(text) || /^… \d+ progress lines omitted$/.test(text))) {
            try { await progress.line(text.replace(/^\[\d+\] /, '').slice(0, 200)); }
            catch (error) { progressError($, error); }
          }
          line = ''; overflow = false;
        }
      }
    }
  }
  const exit = await child.result;
  return parseReport(stdout, exit.code, stderr);
}
function parseReport(stdout, code, stderr = '', lookup = false) {
  const flagRejected = text => Number.isInteger(code) && code !== 0
    && /(?:unknown|unsupported|unexpected|unrecognized|invalid).*--dispatch-nonce|--dispatch-nonce.*(?:unknown|unsupported|unexpected|unrecognized|not supported)/i.test(text);
  const line = stdout.trimEnd().split('\n').filter(line => line.startsWith('{')).at(-1);
  if (!line) {
    const error = new Error(`Duet returned no JSON report (exit ${code}); inspect the job with duet status.`);
    error.nonceFlagRejected = flagRejected(stdout + '\n' + stderr);
    throw error;
  }
  let report;
  try { report = JSON.parse(stdout.trim()); }
  catch { report = JSON.parse(line); }
  if (report?.status === 'error') {
    const error = new Error(report.summary || report.error || 'Duet failed.');
    // The companion has exited unsuccessfully with a structured, jobless
    // error. Only an authoritative empty nonce lookup can prove no launch;
    // a lost pipe, absent JSON or signal without an exit code is insufficient.
    error.launchRejected = Number.isInteger(code) && code !== 0 && !report.jobId;
    error.nonceFlagRejected = !report.jobId && flagRejected(error.message);
    throw error;
  }
  if (!lookup && (!report || typeof report !== 'object' || Array.isArray(report) || !REPORT_STATUSES.has(report.status))) {
    const error = new Error('Duet returned an invalid report status; inspect the job with duet status.');
    error.protocolError = true;
    throw error;
  }
  return report;
}
// Recovery must not open another stream tied to the aborted turn's signal.
async function snapshot($, state, args, { requireSuccess = false, ...timing } = {}) {
  const request = await command($, state, args, '', timing);
  const result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: await processBudget($, timing) });
  if (result.isStdoutTruncated) throw new Error('Duet recovery response was truncated; inspect duet status.');
  const report = parseReport(result.stdout, result.exitCode, result.stderr, args[0] === 'status');
  // Only an absence claim needs a successful lookup; terminal reports such as
  // an interrupted job's `result --report` legitimately exit nonzero.
  if (requireSuccess && result.exitCode !== 0) throw new Error('Duet recovery lookup did not exit successfully; inspect duet status before retrying.');
  return report;
}
// Admission's generation remains even if a rejected turn never creates an
// intent of its own. Older records derive it from their retained context.
const bindingTurn = state => state?.turnId ?? state?.incoming?.turnId ?? state?.intent?.turnId ?? state?.answeredTurn;
const progressError = ($, error) => {
  try { $.ui.log(`Native progress unavailable: ${String(error?.message || error).slice(0, 200)}`, { to: 'debug' }); }
  catch { /* Diagnostics are optional too. */ }
};
// Ancillary work commits a patch of the latest binding, never its old snapshot.
// The turn check also fences callbacks from an older module after a reload.
const save = ($, state, { fields, valid = () => true, close = false,
  turnId = close ? state.intent?.turnId : bindingTurn(state) } = {}) => {
  const key = keyFor(state.session, state.agentId);
  return writeBinding(key, async () => {
    const current = await $.store.get(key);
    if (!valid()) return false;
    if (current && bindingTurn(current) !== turnId) {
      if (!fields && !close) throw new Error('Native binding changed before persistence; refusing stale ownership.');
      return false;
    }
    if (fields && !current) return false;
    const value = fields ? { ...current } : { ...state };
    if (fields) for (const field of fields) {
      if (state[field] !== undefined) value[field] = state[field];
    }
    // A main-path save must not roll back progress committed during its I/O.
    if (current?.notices && value.notices && current.notices.turnId === value.notices.turnId
      && current.notices.count > value.notices.count) value.notices = current.notices;
    if (close) await $.store.set(closedKey(state.session, state.agentId), { turnId: state.intent.turnId, at: await $.clock.now() });
    else await $.store.set(key, value);
    return true;
  });
};
async function handles($, state, jobId, recovery = false, persist = true, { waitMs = 0, ...timing } = {}) {
  const args = ['status', jobId, '--json', ...(waitMs ? ['--wait', '--timeout-ms', String(waitMs), '--poll-interval-ms', '250'] : [])];
  const { job } = await snapshot($, state, args, timing);
  if (!job || job.sessionId !== state.session) throw new Error('Duet job is missing or belongs to another session.');
  if (state.intent?.kind === 'task' && job.dispatchNonce !== state.intent.nonce) throw new Error('Duet dispatch nonce does not match the native launch intent.');
  if (state.jobId === job.id && state.ownerId && state.ownerId !== job.ownerId) throw new Error('Duet job ownership changed; refusing to adopt another owner implicitly.');
  Object.assign(state, { jobId: job.id, ownerId: job.ownerId, threadId: job.threadId, worker: job.agentName,
    status: job.status });
  updateDisplay($, state, job);
  if (persist) await save($, state);
  return job;
}
async function reconcile($, state, recovery = false, allowAbsent = false, { persist = true, ...timing } = {}) {
  const args = ['status', '--all', '--json'];
  timing.deadline ??= await $.clock.now() + await processBudget($, timing);
  const lookup = flags => snapshot($, state, flags, { ...timing, requireSuccess: allowAbsent });
  let status;
  try { status = await lookup([...args, '--dispatch-nonce', state.intent.nonce]); }
  catch (error) {
    if (!error.nonceFlagRejected) throw error;
    status = await lookup(args); // Compatibility with an older companion.
  }
  if (!Array.isArray(status.running) || !Array.isArray(status.recent) || !Object.hasOwn(status, 'latestFinished')) throw new Error('Incomplete Duet nonce reconciliation.');
  const jobs = [...(status.running || []), status.latestFinished, ...(status.recent || [])].filter(Boolean);
  const matches = jobs.filter(job => job.sessionId === state.session && job.dispatchNonce === state.intent.nonce);
  if (allowAbsent && matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('Native launch intent has no unique recorded job. Refusing to redispatch; inspect duet status before retrying.');
  return handles($, state, matches[0].id, recovery, persist, timing);
}
async function drive($, e, state, progress) {
  // Block only a binding known to have failed: permissionMode is optional in
  // the host API, and agents from earlier versions have none.
  if (state.bindingPending) return blocked('Native permission binding is unavailable; nothing was launched. Start a new agent.', state, 'native_binding_unavailable');
  if (state.v === undefined) return blocked('Native dispatch context unavailable (store full, oversized message, or failed turn.start); nothing was launched.', state);
  if (state.v !== 2) return blocked('Unsupported native adapter state version; nothing was dispatched.', state);
  if (state.answeredTurn === e.turnId) return state.answer;
  const durable = await $.store.get(keyFor(state.session, state.agentId));
  if (durable?.intent?.turnId !== state.intent?.turnId
    || (durable?.incoming?.turnId !== e.turnId && durable?.intent?.turnId !== e.turnId)) {
    return blocked('Native dispatch context changed before launch; retry after the active turn finishes.', state);
  }
  if (state.incoming?.turnId !== e.turnId && state.intent?.turnId !== e.turnId) return blocked('Native agent has no durable context for this turn, or another turn is still active.', state);
  let report;
  if (state.intent?.turnId === e.turnId) {
    if (state.intent.kind === 'task') await reconcile($, state);
    // Re-entry after an answer never resubmits it. If the old question is still
    // pending, leave it parked; a new SendMessage can explicitly answer again.
    report = await companion($, state, ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC], '', progress);
    await handles($, state, state.jobId);
  } else {
    let input = state.incoming.text, args, questionChanged = false;
    const answeringDisplayedQuestion = state.answer?.status === 'needs_answer';
    if (!input.trim()) return blocked('Empty native-agent message; nothing was dispatched.', state);
    // Overlapping stop handlers may have saved a stale status; the job record
    // decides before a new message is routed as a dispatch or an answer.
    if (state.jobId && (answeringDisplayedQuestion || ACTIVE.includes(state.status) || state.status === 'needs_answer')) {
      // Read only: the save below persists it together with the new intent.
      const job = await handles($, state, state.jobId, false, false);
      // questionId is the question last returned to Claude, never merely the
      // latest one read by a heartbeat, recovery or this pre-answer refresh.
      const pending = ACTIVE.includes(job.status) && job.pendingQuestion?.answer === undefined ? job.pendingQuestion : null;
      questionChanged = pending?.id !== state.questionId;
      // A pending question keeps the job running; its report says needs_answer.
      if (pending) state.status = 'needs_answer';
      if (answeringDisplayedQuestion && !pending) {
        // The persisted displayed result fixes this message's intent, even if
        // another answer path completed the job while the adapter was unloaded.
        state.intent = { session: state.session, agentId: e.agentId, turnId: e.turnId, kind: 'answer', nonce: nonceFor(state.session, e.agentId, e.turnId) };
        delete state.incoming;
        await save($, state);
        const current = await companion($, state, ['result', state.jobId, '--report']);
        if (current.jobId !== state.jobId) throw new Error('Duet report does not match the recorded job handle.');
        state.status = current.status;
        // An unresolved recovery is not evidence that the old question ended.
        // Preserve its recovery actions and let finalization keep it unanswered.
        if (RECOVERY_STATUSES.includes(current.status)) return current;
        return { ...current, next: nativeNext(state, current.status),
          notice: 'The earlier question was already resolved or ended. Send a new brief to start new work.' };
      }
      if (state.status === 'needs_answer' && state.permissionMode === 'plan' && job.request?.sandbox !== 'read-only') {
        return blocked('Plan mode cannot resume a writable Codex turn; answer outside plan mode or start a read-only agent.', state, 'native_plan_mode_read_only');
      }
    }
    if (ACTIVE.includes(state.status)) return blocked('A Codex job is already running. Wait for completion before sending another assignment.', state);
    if (state.status === 'needs_answer') {
      // Headers are task settings only. A question answer is always verbatim.
      state.intent = { session: state.session, agentId: e.agentId, turnId: e.turnId, kind: 'answer', nonce: nonceFor(state.session, e.agentId, e.turnId) };
      args = questionChanged
        ? ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC]
        : ['answer', state.jobId, '--question', state.questionId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC];
      if (questionChanged) input = '';
    } else {
      const parsed = parsePrompt(input);
      if (state.permissionMode === 'plan') {
        const sandboxAt = parsed.flags.indexOf('--sandbox');
        if (sandboxAt >= 0 && ['workspace-write', 'danger-full-access'].includes(parsed.flags[sandboxAt + 1])) {
          return blocked('Plan mode permits only the read-only Codex sandbox.', state, 'native_plan_mode_read_only');
        }
        if (sandboxAt < 0) parsed.flags.push('--sandbox', 'read-only');
      }
      if (!state.threadId && state.effort && !parsed.flags.includes('--effort')) parsed.flags.push('--effort', state.effort);
      input = parsed.brief;
      if (!input.trim()) return blocked('Empty native-agent brief after DUET header; nothing was dispatched.', state);
      if (state.jobId && !state.threadId) return blocked('Previous job has no Codex thread handle; refusing a replacement thread.', state);
      if (parsed.cwd) {
        const absolute = /^(\/|[A-Za-z]:[\\/])/.test(parsed.cwd) ? parsed.cwd : `${state.cwd}/${parsed.cwd}`;
        const directory = await $.fs.stat(absolute, { resolve: true });
        if (directory.kind !== 'dir' || !directory.realPath) throw new Error('--cwd must resolve to an existing directory.');
        if (state.threadId && directory.realPath !== state.cwd) throw new Error('A native worker continuation must keep its original cwd. Use a new native agent for another workspace.');
        state.cwd = directory.realPath;
      }
      state.intent = { session: state.session, agentId: e.agentId, turnId: e.turnId, kind: 'task', nonce: nonceFor(state.session, e.agentId, e.turnId) };
      args = ['task', ...(state.threadId ? ['--thread', state.threadId] : ['--fresh', ...(state.name && state.name !== state.agentId ? ['--agent-name', state.name] : [])]), ...parsed.flags,
        '--dispatch-nonce', state.intent.nonce, '--timeout-sec', WAIT_TIMEOUT_SEC];
      delete state.jobId; delete state.ownerId; delete state.questionId; delete state.status;
      delete state.cancellation;
    }
    // Persist intent BEFORE any spawn; retain no brief/answer in adapter state.
    delete state.incoming; delete state.answer; delete state.finishedAt;
    try {
      try { await save($, state); }
      catch (error) { error.launchNotStarted = true; throw error; }
      report = await companion($, state, args, input, progress);
    }
    catch (error) {
      if (error.launchNotStarted || (state.intent.kind === 'task' && error.launchRejected
        && await reconcile($, state, true, true) === null)) {
        // An exited companion's error AND an authoritative empty nonce lookup close
        // only this rejected turn. Failed/ambiguous lookups still fail closed.
        await closeTurn($, state);
        return blocked(error.message, state);
      }
      throw error;
    }
    // The task process stays attached throughout the wait. Resolve handles
    // from its durable nonce reservation, never a short dispatch response.
    // If aborted before returning, cancel() resolves that same intent.
    if (state.intent.kind === 'task') await reconcile($, state);
    else await handles($, state, state.jobId);
  }
  await progress.start();
  for (;;) {
    if (!report.jobId || report.jobId !== state.jobId) throw new Error('Duet report does not match the recorded job handle.');
    state.status = report.status;
    await save($, state);
    if (!ACTIVE.includes(report.status)) break;
    // Only a full wait timeout returns active; questions and terminal reports
    // exit above. Await process I/O so waiting does not spend hook budget.
    report = await companion($, state, ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC], '', progress);
    await handles($, state, state.jobId);
  }
  if (report.status === 'needs_answer') await progress.line(`? Waiting for Claude: ${report.question?.text || report.summary}`);
  return { ...report, next: RECOVERY_STATUSES.includes(report.status) || report.blockers?.some(blocker => blocker.code === 'thread_busy')
    ? report.next : nativeNext(state, report.status, report.blockers) };
}
async function cancel($, state, deadline) {
  let job;
  delete state.cancellation;
  const lookup = { deadline, timeoutMs: 500, reserveMs: 2000 };
  try {
    if (state.intent?.kind === 'task' && !state.jobId) await reconcile($, state, true, false, { ...lookup, persist: false });
    if (!state.jobId) return;
    // Both callers are stopping a native owner. Give its worker one bounded,
    // read-only chance to confirm owner_stopped before the cancel safety net.
    // Terminal records return immediately; an unavailable lookup still falls
    // through to cancel using the already-recorded job handle.
    const timing = { deadline, timeoutMs: 2000, reserveMs: 2000 };
    try {
      const waitMs = Math.max(1, await processBudget($, timing) - 150);
      job = await handles($, state, state.jobId, true, false, { ...timing, waitMs });
    } catch { /* A failed/timed-out observation must not suppress cancellation. */ }
    if (job?.interruptionConfirmed !== true) {
      const timing = { deadline, timeoutMs: 1500, reserveMs: 500 };
      const request = await command($, state, ['cancel', state.jobId, '--json'], '', timing);
      let result, failure;
      try {
        result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: await processBudget($, timing) });
      } catch (error) { failure = error; }
      // The CLI may have sent its interrupt before timing out. Always use the
      // reserved final read to look for durable confirmation, even on rejection.
      try { job = await handles($, state, state.jobId, true, false, { deadline, timeoutMs: 500 }); }
      catch (error) { failure ||= error; }
      if (job?.interruptionConfirmed !== true) {
        if (!result) throw failure;
        state.cancellation = JSON.parse(result.stdout);
      }
    }
    if (['interrupted', 'cancelled'].includes(job?.status) && job.interruptionConfirmed === true) {
      state.cancellation = { jobId: job.id, status: job.status, confirmation: 'confirmed', turnInterrupted: true, reason: job.interruptionReason };
    }
    state.status = state.cancellation?.status || 'blocked';
    state.finishedAt = await $.clock.now();
  } catch (error) {
    state.cancellation = { status: 'unconfirmed', message: 'Cancellation unconfirmed; inspect duet status. Owner-loss and question timeout remain the fallback.',
      error: String(error?.message || error).slice(0, 200) };
  }
  await save($, state, { turnId: state.intent?.turnId,
    fields: ['jobId', 'ownerId', 'threadId', 'worker', 'status', 'finishedAt', 'cancellation'] });
  return job;
}
// Closure is its own key: a stale snapshot saved by an overlapping handler can
// rewrite the state record but never reopen a turn proven to have ended.
const closeTurn = ($, state) => save($, state, { close: true });
const isClosed = async ($, state) => !!state.intent && (await $.store.get(closedKey(state.session, state.agentId)))?.turnId === state.intent.turnId;
// Cancel the recorded job; close its turn only with evidence that it ended.
async function stopJob($, state, deadline) {
  // Leave 500 ms of the host's 5 s abort linger for store/dispatch overhead.
  deadline ??= await $.clock.now() + 4500;
  const job = await cancel($, state, deadline);
  if (!job) return null;
  const confirmed = state.cancellation?.confirmation === 'confirmed' && state.cancellation.jobId === job.id;
  // Just after a confirmed cancel the job record can still read running.
  state.status = confirmed && ACTIVE.includes(job.status) ? state.cancellation.status : job.status;
  if (!ended(job, state)) return null;
  await closeTurn($, state);
  await save($, state, { turnId: state.intent?.turnId, fields: ['status', 'cancellation', 'finishedAt'] });
  return job;
}
// An open turn whose stop could not be confirmed may have ended since (for
// example through duet cancel); the job record decides.
async function recheck($, state) {
  const job = state.jobId ? await handles($, state, state.jobId, true)
    : state.intent?.kind === 'task' ? await reconcile($, state, true) : null;
  if (job?.pendingQuestion && ACTIVE.includes(job.status)) {
    // A displayed question's final save may have been lost. Admit a message
    // only to re-show the current question, never guess which one was shown.
    state.status = 'needs_answer'; state.questionId = null;
    await save($, state);
    return true;
  }
  if (!job || !ended(job, state)) return false;
  await closeTurn($, state);
  return true;
}
const cancelledReport = (state, status) => ({ status, worker: state.worker || null, jobId: state.jobId,
  summary: 'Stopped from /tasks; the Codex turn was cancelled.', next: nativeNext(state, status),
  details: nativeDetails(state) });
// Claude Code refuses host process calls in a dispatch aborted from /tasks, so
// the step cannot confirm its own stop. The host has killed the owner wait,
// which makes the worker interrupt; turn.complete records the confirmation.
const stoppingReport = state => ({ status: 'interrupted', worker: state.worker || null, jobId: state.jobId,
  summary: `Stopped from /tasks. The owner wait was stopped, so the worker interrupts the Codex turn and ends the commands it started; duet status ${state.worker || state.jobId} shows the recorded confirmation.`,
  next: nativeNext(state, 'interrupted'), details: nativeDetails(state) });
async function stoppedReport($, state) {
  const deadline = await $.clock.now() + 4500;
  const job = await stopJob($, state, deadline);
  if (!job) return null;
  if (ACTIVE.includes(job.status)) return cancelledReport(state, state.status);
  const report = await snapshot($, state, ['result', job.id, '--report'], { deadline, timeoutMs: 500 });
  if (report.jobId !== job.id) throw new Error('Duet report does not match the recorded job handle.');
  if (RECOVERY_STATUSES.includes(report.status)) return report;
  return { ...report, status: job.status, worker: job.agentName || null, jobId: job.id, next: nativeNext(state, job.status) };
}

// Each observer has at most 200 pending lines. The producer waits for space,
// keeping progress bounded even if Claude stops pulling the turn stream.
function observer() {
  const queue = [], spaces = new Set(); let wake, closed = false;
  const release = () => { for (const resolve of spaces) resolve(); spaces.clear(); };
  return {
    async push(text) {
      while (!closed && queue.length >= 200) await new Promise(resolve => { spaces.add(resolve); });
      if (!closed) { queue.push(text); wake?.(); wake = null; }
    },
    close() { closed = true; wake?.(); release(); },
    async *read(flight) {
      while (!flight.done || queue.length) {
        if (!queue.length) { await new Promise(resolve => { wake = resolve; }); continue; }
        const text = queue.shift(); release();
        yield { kind: 'thinking', index: 0, text };
      }
    }
  };
}
function progressFor($, e, state, publish, currentFlight) {
  let starting, lookup, busy = false, keepaliveInFlight = false, stopped = false, lastAt, lastStreamedAt, startedAt;
  let enrichmentDeadline, enrichmentFailed = false;
  let noticing = Promise.resolve();
  const feed = liveProgress.get(e.agentId);
  const notices = state.notices?.turnId === e.turnId ? state.notices : { turnId: e.turnId, count: 0 };
  state.notices = notices;
  const active = () => !stopped && currentFlight() && bindingTurn(state) === e.turnId;
  const persist = (fields = ['notices']) => save($, state, { fields, valid: active });
  const optional = async action => {
    try { await action(); } catch (error) { progressError($, error); }
  };
  const stream = async text => {
    if (!active()) return;
    await publish(`${text}\n`);
    lastStreamedAt = await $.clock.now();
  };
  const notice = (value, final = false, alreadyStreamed = false) => {
    const text = value.slice(0, 200);
    const pending = noticing.then(async () => {
      if (!active()) return;
      // The display log has its own short dedupe window. Command starts never
      // consume durable admission or change its last-line/count bookkeeping.
      if (feed && liveProgress.get(e.agentId) === feed) appendLog($, feed, text);
      if (!final && commandStart(text)) return;
      if ((!final && notices.count >= 200) || notices.last === text) return;
      const result = await $.session.append({ agentId: state.agentId,
        message: { type: 'system', content: [{ type: 'text', text }] } });
      if (!active()) return;
      if (result?.deny) throw new Error(`Native progress notice refused: ${result.deny}`);
      notices.count++; notices.last = text;
      // Hook-generated thinking is visible live but is not recorded by the host;
      // the system notice above remains the durable, model-invisible copy. Keep
      // usage's existing final notice exemption without exceeding the live cap.
      if (!alreadyStreamed && notices.count <= 200) await stream(text);
      await persist();
    });
    noticing = pending.catch(error => { progressError($, error); });
    return noticing;
  };
  const start = async () => {
    if (!active() || notices.started || enrichmentFailed || !state.intent) return;
    if (!starting) starting = (async () => {
      // The CLI does not print a launch receipt. Resolve the durable nonce at
      // the first activity/heartbeat; never invent a handle or redispatch.
      const observed = { ...state };
      const now = await $.clock.now();
      enrichmentDeadline ??= now + 15000;
      if (!active()) return;
      if (now >= enrichmentDeadline) { enrichmentFailed = true; return; }
      // One flight budget covers nonce discovery and the subsequent job read;
      // buffered owner lines must never each receive a fresh lookup budget.
      const deadline = enrichmentDeadline;
      lookup = observed.jobId ? handles($, observed, observed.jobId, false, false, { deadline })
        : reconcile($, observed, false, false, { persist: false, deadline });
      let job;
      try { job = await lookup; } finally { lookup = null; }
      if (!active()) return;
      const fields = ['jobId', 'ownerId', 'threadId', 'worker'];
      for (const field of fields) state[field] = observed[field];
      if (!state.status || ACTIVE.includes(state.status)) state.status = observed.status;
      await persist(fields);
      await notice(`Codex worker ${job.agentName || state.name} started · job ${job.id} · ${job.request?.model} / ${job.request?.effort} / ${job.request?.sandbox}`);
      if (!active()) return;
      notices.started = true;
      await persist();
    })().catch(error => { enrichmentFailed = true; throw error; }).finally(() => { starting = null; });
    await optional(() => starting);
  };
  return {
    start,
    async stop() {
      stopped = true;
      // The host bounds and terminates this process. Join it before releasing
      // the flight; late lookup results cannot publish or persist anything.
      await optional(() => lookup);
    },
    async usage(value) {
      if (!active() || !value || notices.usage || !['inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return;
      const count = number => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      await notice(`Codex usage · ${count(value.inputTokens)} input (${count(value.cachedInputTokens)} cached) · ${count(value.outputTokens)} output tokens`, true);
      if (!active()) return;
      notices.usage = true;
      await optional(() => persist());
    },
    async line(text) {
      await optional(async () => {
        lastAt = await $.clock.now();
        await start();
        await notice(text);
      });
    },
    async begin() {
      startedAt = lastAt = lastStreamedAt = await $.clock.now();
      updateDisplay($, state);
    },
    async heartbeat() {
      if (!active() || keepaliveInFlight) return;
      const now = await $.clock.now();
      if (!active() || keepaliveInFlight) return;
      const seconds = Math.floor((now - startedAt) / 1000);
      const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const text = () => `Codex worker ${state.worker || state.name || state.agentId} running · ${elapsed}`.slice(0, 200);
      // Keep the watchdog alive before any ancillary work, even while an older
      // lookup or notice is pending. Only keepalives bypass durable admission.
      const due = now - lastStreamedAt >= HEARTBEAT_MS;
      if (due) {
        // A full observer queue backpressures publish. Later timer ticks must
        // not accumulate more blocked publications while this one waits.
        keepaliveInFlight = true;
        try { await stream(text()); } finally { keepaliveInFlight = false; }
      }
      if (!active() || busy || now - lastAt < HEARTBEAT_MS) return;
      busy = true;
      void (async () => {
        await start();
        if (active() && now - lastAt >= HEARTBEAT_MS) {
          lastAt = now;
          await notice(text(), false, due);
        }
      })().catch(error => { progressError($, error); }).finally(() => { busy = false; });
    }
  };
}

export function register(on) {
  let registered = false;
  const announcing = new Map(), announced = new Set();
  const efforts = new Map(), spawning = new Map(), observedBindings = new Map(), refusals = new Map(), resumedSpawns = new Set();
  const pendingBinding = (key, now) => {
    if (dispatching.has(key) || [...spawning].some(([session, bindings]) =>
      [...bindings].some(binding => binding.agentId && keyFor(session, binding.agentId) === key))) return true;
    const observed = observedBindings.get(key);
    if (observed && now - observed.at < ORPHAN_GUARD_MS) return true;
    observedBindings.delete(key); resumedSpawns.delete(key);
    return false;
  };
  const restoreBinding = (key, state) => {
    const binding = observedBindings.get(key);
    if (binding) delete state.bindingPending;
    if (binding?.permissionMode !== undefined) {
      // A resumed spawn's observation wins over an older durable binding.
      state.permissionMode = binding.permissionMode;
      delete state.bindingPending;
    }
    if (binding?.effort !== undefined) state.effort = binding.effort;
  };
  nodes.clear(); flights.clear(); startedTypes.clear(); knownTypes.clear(); dispatching.clear(); liveProgress.clear(); unstartedSince.clear();
  toolAgents.clear(); agentDisplays.clear(); promptTurns.clear(); turnPrompts.clear(); turnLogs.clear();
  on('session.append', async ($, e, next) => {
    const result = await next(e);
    try {
      // d.ts: render requestId is the message id; append uuid is that row's
      // pinned id on every later read. Main rows have no agentId. No text-only
      // fallback: an unobserved row (including after reload) draws alone.
      if (result?.deny || !e.agentId || e.message.type !== 'user'
        || !['prompt', 'delivery'].includes(e.door) || promptTurns.has(e.uuid)) return result;
      // A row can arrive before native identification. Retain the bounded
      // candidate now; only a native turn.start can bind it to a visible log.
      const text = result.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text.length > 65536) return result;
      rememberDisplay(promptTurns, e.uuid, { agentId: e.agentId, text: text.trim() });
      for (const turn of turnPrompts.values()) if (turn.agentId === e.agentId) bindPrompt($, turn);
    } catch { /* Observing a kept row must never interfere with the append. */ }
    return result;
  }).catch(passthrough);
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const turn = promptTurns.get(e.requestId);
    if (!turn?.turnId) return next(e);
    const prompt = promptDisplay(e.props.text);
    const engine = await next(prompt ? { ...e, props: { ...e.props, text: prompt.text } } : e);
    const log = turnLogs.get(logKey(turn.agentId, turn.turnId));
    if (!prompt && !log?.entries.length) return engine;
    return { type: 'Box', props: { flexDirection: 'column' }, children: [
      ...(prompt ? [displayRow(e, [prompt.header], { dimColor: true })] : []),
      engine,
      ...(log?.omitted ? [displayRow(e, [`… ${log.omitted} earlier lines (ctrl+o for the full record)`], { dimColor: true })] : []),
      ...(log?.entries.map(entry => logRows(e, entry)) ?? [])
    ] };
  }).catch(passthrough);
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    const view = agentDisplays.get(e.requestId);
    if (!view) return next(e);
    return displayRow(e, [
      { type: 'Text', props: { bold: true }, children: [view.name.replace(/\s+/g, ' ')] },
      { type: 'Text', props: { dimColor: true }, children: [
        ` · ${view.status === 'running' ? 'running' : displayStatus(view.status)} · ${elapsedDisplay(view.elapsedMs)}`
      ] }
    ]);
  }).catch(passthrough);
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Agent' || e.props.input?.subagent_type !== AGENT_TYPE) return next(e);
    const id = toolAgents.get(e.props.tool_use_id);
    if (!id) return next(e);
    const engine = await next(e), view = agentDisplays.get(id);
    if (!view) return engine;
    const feed = liveProgress.get(id), rows = [];
    if (feed) {
      const rest = [view.model, view.effort, view.speed, elapsedDisplay(view.elapsedMs)]
        .filter(Boolean).map(part => part.replace(/\s+/g, ' '));
      rows.push(displayRow(e, [
        { type: 'Text', props: { bold: true }, children: [view.name.replace(/\s+/g, ' ')] },
        { type: 'Text', props: { dimColor: true }, children: [` · ${rest.join(' · ')}`] }
      ]), ...feed.entries.slice(-3).map(entry => displayRow(e, ['⎿ ' + entryText(entry).replace(/\s+/g, ' ')], entryStyle(entry))));
    } else rows.push(progressRow(e, `${view.name} · ${displayStatus(view.status)} · ${elapsedDisplay(view.elapsedMs)}`));
    if (view.question) rows.push(progressRow(e, `Question: ${view.question}`, '⎿ '));
    return { type: 'Box', props: { flexDirection: 'column' }, children: [engine, ...rows] };
  }).catch(passthrough);
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = reportMarkdown(e.props);
    return text === null ? next(e) : next({ ...e, props: { ...e.props, text } });
  }).catch(passthrough);
  // 2.1.302 d.ts 13296-13304, 16715-16716: tool.call carries the flat Agent
  // arguments, including explicit effort; turn.step's effective effort also
  // includes the shell definition's low and cannot distinguish that default.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool === 'Agent' && e.subagent_type === AGENT_TYPE) {
      const session = await $.session.id(), key = keyFor(session, e.tool_use_id);
      efforts.delete(key);
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(e.effort)) efforts.set(key, e.effort);
      // Denied calls have no spawn to consume their entry.
      if (efforts.size > 128) efforts.delete(efforts.keys().next().value);
      // AgentSpawnInput.name is pinned. Reserve through the shared companion
      // before the Agent tool creates that address; never rename a resumption.
      if (!e.resume && session) {
        const deadline = await $.clock.now() + 2000;
        const cwd = await $.session.root();
        const base = typeof e.name === 'string' ? e.name.replace(/-(?:[2-9]|[1-9]\d+)$/, '').toLowerCase() : '';
        const preferred = [TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES]
          .some(names => names.some(name => name.toLowerCase() === base));
        const timeoutMs = await processBudget($, { deadline, timeoutMs: 2000 });
        let timer;
        // A shared discovery may have started with another call's longer
        // timeout. Bound our wait too, without cancelling that caller's probe.
        const executable = await Promise.race([node($, timeoutMs), new Promise((resolve, reject) => {
          timer = $.clock.after(timeoutMs, () => reject(new Error('Native name reservation timed out.')));
        })]).finally(() => timer?.cancel());
        const result = await $.process.run([executable, `${$.plugin.root}/scripts/codex-companion.mjs`,
          'reserve-name', '--session-cwd', cwd, '--session', session,
          ...(preferred ? ['--preferred', e.name] : [])], { cwd, timeoutMs: await processBudget($, { deadline, timeoutMs: 2000 }) });
        if (result.exitCode === 0 && !result.isStdoutTruncated) {
          const { name } = JSON.parse(result.stdout);
          if (typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
            const response = await next({ ...e, name });
            // Background launch acknowledgements carry no content array, so tell
            // the model through context (read after the result, never shown)
            // and leave the result itself untouched. A deny stays as it is.
            if (name === e.name || !response || response.deny !== undefined) return response;
            const requested = e.name === undefined ? '' : ` (requested ${JSON.stringify(e.name)})`;
            return { ...response, context: [...(Array.isArray(response.context) ? response.context : []),
              `Codex worker named ${name}${requested}; use SendMessage to ${name} for follow-ups.`] };
          }
        }
      }
    }
    return next(e);
  }).catch(passthrough);
  on('agent.spawn', { subagentType: AGENT_TYPE }, async ($, e, next) => {
    if (e.subagentType !== AGENT_TYPE) return next(e);
    const session = await $.session.id(), callKey = keyFor(session, e.tool_use_id);
    const effort = efforts.get(callKey);
    efforts.delete(callKey);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const spawnBinding = { pending, agentId: e.resume?.agentId };
    const bindings = spawning.get(session) || new Set();
    spawning.set(session, bindings); bindings.add(spawnBinding);
    try {
      // AgentSpawnResult (d.ts 414-419) resolves at start, not completion.
      // A first turn waits below until settings are observed for its id.
      const result = await next(e);
      if (result.agentId) {
        rememberDisplay(toolAgents, e.tool_use_id, result.agentId);
        invalidateProgress($);
        spawnBinding.agentId = result.agentId;
        knownTypes.set(result.agentId, AGENT_TYPE);
        const key = keyFor(session, result.agentId);
        // Retain the observation before any store access can fail. start and
        // step run in separate dispatches, but share this module's bindings.
        observedBindings.set(key, { ...observedBindings.get(key), at: await $.clock.now(),
          ...(e.permissionMode !== undefined ? { permissionMode: e.permissionMode } : {}),
          ...(!e.resume && effort ? { effort } : {}),
          // The explicit Agent name survives agent-list discovery failures.
          ...(e.name ? { name: e.name } : {}) });
        // Return without store work: the host delivers this agent's turn.start
        // to us only after this hook returns (or its bound passes), and a slow
        // admission scan here made it skip turn.start entirely. turn.start
        // performs admission, eviction and the durable binding write.
        if (e.resume) resumedSpawns.add(key); else resumedSpawns.delete(key);
        // One small durable guard (not the admission scan) until turn.start
        // persists the binding, so a reload in between still fails closed.
        await $.store.set(bindingFailedKey(session, result.agentId), { bindingPending: true, at: await $.clock.now() }).catch(() => {});
      }
      return result;
    } finally { bindings.delete(spawnBinding); if (!bindings.size) spawning.delete(session); release(); }
  }).catch(passthrough);
  // 2.1.302 d.ts: SubagentStartHookInput (12829-12833) carries the exact
  // agent_id/type before its loop starts; TurnStartInput/TurnStepInput carry
  // only agentId (14060-14068, 14139-14147), not the agent's system prompt.
  // Keep this independent of discovery AND store availability. turn.start
  // persists the normal binding; the in-memory one also lets .catch fail closed.
  on('classic.SubagentStart', async ($, e, next) => {
    startedTypes.set(keyFor(e.session_id, e.agent_id), e.agent_type);
    knownTypes.set(e.agent_id, e.agent_type);
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    const agent = await ours($, e.agentId);
    if (!agent) return next(e);
    const session = await $.session.id(), key = keyFor(session, e.agentId);
    if (dispatching.has(key)) return next(e);
    const lock = {};
    dispatching.set(key, lock);
    try {
      // Per-agent waits and recovery lookups stay outside the shared queue:
      // another agent's turn.start budget runs while it waits there.
      let state, candidate, bindingFailed;
      const refuse = async code => {
        refusals.set(key, { turnId: e.turnId, report: admissionBlocked(code, state || { agentId: e.agentId, name: agent.name }) });
        agentDisplays.delete(e.agentId);
        invalidateProgress($);
        resumedSpawns.delete(key); observedBindings.delete(key);
        // Nothing launched: even a retained, versioned binding must lose this
        // spawn's guard so a later reload cannot mistake it for pending work.
        if (state && !state.v && !state.intent && !state.incoming) await $.store.delete(key);
        await $.store.delete(bindingFailedKey(session, e.agentId));
      };
      const prepared = await (async () => {
        state = await $.store.get(key);
        // Wait only for this agent's own spawn (its guard write may still be in
        // flight); unrelated session spawns would spend this hook's budget.
        const own = [...(spawning.get(session) || [])].filter(binding => binding.agentId === e.agentId);
        if (own.length || (!state && !observedBindings.has(key))) {
          await Promise.all(own.map(binding => binding.pending));
          state = await $.store.get(key);
        }
        // Reject oversized input before recheck, pruning or any binding write.
        if (e.text.length > 65536) return await refuse('native_message_too_large');
        rememberPrompt($, e);
        if (state) restoreBinding(key, state);
        if (state?.answeredTurn === e.turnId || state?.intent?.turnId === e.turnId || state?.incoming?.turnId === e.turnId) {
          // A redelivered start: this turn already persisted its binding, so the
          // spawn-time guard is stale.
          if (observedBindings.has(key) && !state.bindingPending) {
            await save($, state);
            await $.store.delete(bindingFailedKey(session, e.agentId));
            observedBindings.delete(key); resumedSpawns.delete(key);
          }
          return;
        }
        if (state?.intent && state.intent.turnId !== state.answeredTurn && !await isClosed($, state)
          && !await recheck($, state).catch(() => false)) return;
        if (refusals.get(key)?.report.blockers[0].code === 'native_binding_gone') return await refuse('native_binding_gone');
        refusals.delete(key);
        candidate = { ...(state || { type: AGENT_TYPE, session, agentId: e.agentId, name: (agent.name !== e.agentId && agent.name) || observedBindings.get(key)?.name,
          bindingPending: !observedBindings.has(key) }), turnId: e.turnId, incoming: { turnId: e.turnId, text: e.text } };
        bindingFailed = await $.store.get(bindingFailedKey(session, e.agentId));
        if (bindingFailed) candidate.bindingPending = true;
        restoreBinding(key, candidate);
        if (!candidate.v) {
          const directory = await $.fs.stat(await $.session.cwd(), { resolve: true });
          if (directory.kind !== 'dir' || !directory.realPath) throw new Error('Native workspace must resolve to an existing directory.');
          candidate.v = 2; candidate.cwd = directory.realPath;
        }
        delete candidate.finishedAt;
        return true;
      })();
      if (prepared) await serializeAdmission(async () => {
        const reserveSize = stateSize(candidate) - (state ? stateSize(state) : 0);
        const now = await $.clock.now();
        const budget = await prune($, { reserveCount: state ? 0 : 1, reserveSize, keepKey: key,
          pending: key => pendingBinding(key, now) });
        const code = await writeBinding(key, async () => {
          // Pruning may await a cancellation writer. Only now take the final
          // snapshot, rebase admission fields, and charge its actual byte delta.
          const latest = await $.store.get(key);
          if (state && !latest) return 'native_binding_gone';
          const value = { ...(latest || candidate), turnId: e.turnId, incoming: candidate.incoming,
            v: latest?.v ?? candidate.v, cwd: latest?.cwd ?? candidate.cwd,
            ...(candidate.bindingPending ? { bindingPending: true } : {}) };
          delete value.finishedAt;
          restoreBinding(key, value);
          if (budget.count + Number(!budget.keepSize) > MAX_RECORDS
            || budget.size - budget.keepSize + stateSize(value) > MAX_STORE_SIZE) return 'native_capacity';
          if (!latest && (resumedSpawns.has(key) || (!observedBindings.has(key) && !bindingFailed))) return 'native_binding_gone';
          // One retry while holding the slot; never recursively acquire save.
          try { await $.store.set(key, value); } catch { await $.store.set(key, value); }
          state = value;
          return null;
        });
        if (code) return await refuse(code);
        resumedSpawns.delete(key);
        if (!state.bindingPending) await $.store.delete(bindingFailedKey(session, e.agentId));
        observedBindings.delete(key);
      });
      return next(e);
    } finally { if (dispatching.get(key) === lock) dispatching.delete(key); }
  }).catch(passthrough);
  on('turn.step', async function* ($, e, next) {
    const session = await $.session.id(), key = keyFor(session, e.agentId);
    const refusal = refusals.get(key);
    if (refusal && (!refusal.turnId || refusal.turnId === e.turnId)) return yield* finish(e, refusal.report);
    const agent = await ours($, e.agentId);
    if (!agent) return yield* next(e);
    if (!await $.store.get(key) && !await $.store.get(bindingFailedKey(session, e.agentId))) {
      return yield* finish(e, admissionBlocked('native_binding_gone', { agentId: e.agentId, name: agent.name }));
    }
    const flight = `${key}:${e.turnId}`;
    const listener = observer();
    let running = flights.get(flight);
    if (!running) {
      // Do not wait on another turn's stream (which spends this hook's budget).
      // One agent owns the dispatch lock; a concurrent turn is refused.
      if (dispatching.has(key)) return yield* finish(e, blocked('Another turn is active for this native agent; retry after it finishes.', { agentId: e.agentId }));
      running = { listeners: new Set(), done: false,
        feed: { agentId: e.agentId, turnId: e.turnId, entries: [], omitted: 0 },
        display: { turnId: e.turnId, name: agent.name || e.agentId, elapsedMs: 0, status: 'running' } };
      dispatching.set(key, running);
      flights.set(flight, running);
      liveProgress.set(e.agentId, running.feed);
      rememberDisplay(agentDisplays, e.agentId, running.display);
      rememberDisplay(turnLogs, logKey(e.agentId, e.turnId), running.feed);
      invalidateProgress($);
      running.listeners.add(listener);
      running.result = (async () => {
        try {
          running.display.startedAt = await $.clock.now();
          running.tick = $.clock.every(1000, async () => {
            try {
              const now = await $.clock.now();
              if (liveProgress.get(e.agentId) !== running.feed) return;
              running.display.elapsedMs = Math.max(0, now - running.display.startedAt);
              invalidateProgress($);
            } catch { /* A display tick cannot affect the flight. */ }
          });
        } catch { /* Rendering still updates on progress if timers are unavailable. */ }
        const state = await $.store.get(key) || { session, agentId: e.agentId, name: agent.name };
        if (state.incoming?.turnId === e.turnId) rememberPrompt($, { ...e, text: state.incoming.text });
        if (await $.store.get(bindingFailedKey(session, e.agentId))) state.bindingPending = true;
        restoreBinding(key, state);
        const progress = progressFor($, e, state, text => Promise.all([...running.listeners].map(item => item.push(text))),
          () => !running.done && dispatching.get(key) === running);
        await progress.begin();
        // Pending process I/O suspends the hook budget. Timer callbacks only
        // wake the generator; never poll with clock.sleep (which spends it).
        const timer = $.clock.every(HEARTBEAT_MS, () => progress.heartbeat().catch(() => {}));
        // Learn the job handles soon after dispatch, before any progress line:
        // a stop from /tasks can no longer run the lookup itself.
        const early = $.clock.after(EARLY_HANDLES_MS, () => progress.start().catch(() => {}));
        let report, uncertain = false, stopping = false;
        try {
          report = await drive($, e, state, progress);
          if (report.status === 'owner_stopped') {
            stopping = true;
            report = await stoppedReport($, state) || report;
          }
          if (RECOVERY_STATUSES.includes(report.status)) {
            uncertain = true;
            report = { ...report, status: 'blocked' };
          }
          await progress.usage(report.usage);
        } catch (error) {
          const aborted = state.intent?.turnId === e.turnId && (next.signal?.aborted || error?.name === 'AbortError' || /process\.spawn\(.*\) aborted$/.test(error?.message || ''));
          if (aborted) {
            // No process calls here: the host refuses them in a stopped dispatch.
            stopping = true;
            report = state.jobId ? stoppingReport(state)
              : blocked('Stopped from /tasks before Duet recorded the job; run duet status --all before retrying.', state, 'native_stop_unconfirmed');
          }
          report ||= blocked(error?.message || 'Native adapter failed.', state);
          uncertain ||= state.intent?.turnId === e.turnId && (error.protocolError || !state.jobId || ACTIVE.includes(state.status));
        } finally { timer.cancel(); early.cancel(); await progress.stop(); }
        // A stopped turn closes only through closeTurn's evidence, and no turn
        // closes while its job still reads active.
        if (state.intent?.turnId === e.turnId && (ACTIVE.includes(state.status) || stopping)) {
          uncertain ||= ACTIVE.includes(state.status) || !await isClosed($, state).catch(() => false);
        }
        // Do not overwrite a different active turn's handles or saved answer.
        if (state.v === 2 && (state.incoming?.turnId === e.turnId || state.intent?.turnId === e.turnId)) {
          delete state.incoming;
          state.answer = report;
          // A turn that failed before recording its own intent leaves the
          // previous intent's closure as it was.
          if (!uncertain && (!state.intent || state.intent.turnId === e.turnId)) state.answeredTurn = e.turnId;
          if (!uncertain && report.status !== 'needs_answer' && !ACTIVE.includes(state.status)) state.finishedAt = await $.clock.now();
          // questionId means shown to Claude, not observed in the job. Earlier
          // saves can fail and turn the response into blocked; only this path
          // commits the question whose needs_answer report we actually return.
          if (report.status === 'needs_answer') state.questionId = report.question?.id ?? null;
          try { await save($, state); }
          catch (error) {
            // A store may commit and then throw. Still return that question,
            // never a blocked report that would leave an unseen id as shown.
            if (report.status !== 'needs_answer') throw error;
            // Retry a transient pre-commit failure too, so the displayed
            // question remains answerable. Persistent failure is repaired by
            // recheck re-showing the job's current question conservatively.
            await save($, state).catch(() => {});
          }
        }
        running.display.status = report.status;
        running.display.name = report.worker || state.worker || state.name || running.display.name;
        running.display.question = ['needs_answer', 'needs_input'].includes(report.status)
          ? (typeof report.question === 'string' ? report.question : report.question?.text)?.slice(0, 200) : undefined;
        return report;
      })().finally(async () => {
        running.done = true;
        try { running.tick?.cancel(); } catch { /* Best-effort display teardown. */ }
        // An unsettled adapter error is handed back as blocked by turn.step's catch.
        if (running.display.status === 'running') running.display.status = 'blocked';
        try {
          if (Number.isFinite(running.display.startedAt)) running.display.elapsedMs = Math.max(0, await $.clock.now() - running.display.startedAt);
        } catch { /* Keep the last tick. */ }
        for (const item of running.listeners) item.close();
        flights.delete(flight);
        if (dispatching.get(key) === running) dispatching.delete(key);
        if (liveProgress.get(e.agentId) === running.feed) {
          liveProgress.delete(e.agentId);
          rememberDisplay(agentDisplays, e.agentId, running.display);
          invalidateProgress($);
        }
      });
      // A failing host/store call is rethrown after draining, not unhandled.
      running.result.catch(() => {});
    } else running.listeners.add(listener);
    try {
      yield* listener.read(running);
      return yield* finish(e, await running.result);
    } finally { running.listeners.delete(listener); listener.close(); }
  }).catch(async function* ($, e, next) {
    if (!e.agentId || (knownTypes.has(e.agentId) && knownTypes.get(e.agentId) !== AGENT_TYPE)) return yield* next(e);
    return yield* finish(e, blocked('Native adapter hook failed; inspect duet status before retrying.', { agentId: e.agentId }));
  });
  on('turn.complete', async ($, e, next) => {
    if (e.isAborted && await ours($, e.agentId)) {
      const sessionId = await $.session.id();
      const state = await $.store.get(keyFor(sessionId, e.agentId));
      // A cancelled wait may report owner_stopped before this callback. Still
      // cancel its recorded job; do not rely on the report's status label.
      // stopJob closes the turn (for a later SendMessage) only with evidence it
      // ended; a job that may still run keeps it open until duet cancel.
      if (state?.intent?.turnId === e.turnId) {
        const deadline = await $.clock.now() + 4500;
        // An aborted step may have synthesized its stop report because process
        // calls were already forbidden. Claude received that report even if
        // the worker has not finished interrupting yet.
        if (state.jobId && state.answer?.jobId === state.jobId
            && ['interrupted', 'cancelled', 'owner_stopped'].includes(state.answer.status)) {
          try {
            await $.process.run(['node', `${$.plugin.root}/scripts/lib/report-delivery.mjs`, '--mark-emitted'], {
              stdin: JSON.stringify({ sessionId, jobIds: [state.jobId] }), timeoutMs: 500
            });
          } catch { /* Leave an undelivered-ending notice as the fallback. */ }
        }
        await stopJob($, state, deadline);
      }
    }
    return next(e);
  }).catch(passthrough);
  // Register last: a partial native registration never advertises readiness.
  // Announce on the first prompt a person sends that reaches the model; a slash
  // command (such as /reload-plugins) may never ask the model.
  on('prompt.submit', { origin: { kind: PERSON_ORIGINS } }, async ($, e, next) => {
    if (!registered || e.command || !PERSON_ORIGINS.includes(e.origin?.kind)) return next(e);
    const session = await $.session.id(), key = `native:ready:v1:${session}`;
    // Claim synchronously after the last await, so concurrent prompts attach
    // once; persist only after the prompt entered, so a dropped one does not
    // consume the announcement.
    // A concurrent prompt waits for a pending claim, which may still drop.
    for (let pending; (pending = announcing.get(session));) await pending;
    if (announced.has(session) || await $.store.get(key)) { announced.add(session); return next(e); }
    for (let pending; (pending = announcing.get(session));) await pending;
    if (announced.has(session)) return next(e);
    let release;
    announcing.set(session, new Promise(resolve => { release = resolve; }));
    try {
      const result = await next({ ...e, context: [...(e.context || []), READY] });
      if (!result?.drop) { announced.add(session); await $.store.set(key, true); }
      return result;
    } finally { announcing.delete(session); release(); }
  }).catch(passthrough);
  // The one-time notice above is lost when the conversation compacts; the
  // system prompt is rebuilt for every request, including mid-turn after an
  // automatic compaction. Only requests that can dispatch agents get it.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e);
    if (!registered || !e.tools?.includes('Agent') || !Array.isArray(result?.sections)
        || result.sections.some(section => section.id === GUIDE_ID)) return result;
    return { ...result, sections: [...result.sections, { id: GUIDE_ID, text: NATIVE_GUIDE, scope: 'session' }] };
  }).catch(passthrough);
  registered = true;
}

async function* finish(e, report) {
  // 2.1.302 d.ts 14211-14214 calls usage "What the request cost as the API
  // reported it". Codex tokens belong in the report/notice, never this ledger.
  const text = JSON.stringify(report);
  yield { kind: 'text', index: 1, text };
  yield { kind: 'stop', stopReason: 'end_turn', usage: null };
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null };
}
