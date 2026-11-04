import { test, expect, mock } from 'claude-code/testing';
import { captures as recordedCaptures } from './native-captures.mjs';
import { register as registerNative, logEntry, foldEntries, eventRow, logRows, proseRows, headerRow, statusRow, reportMarkdown, textWidth } from '../hooks/native-agent.mjs';
import { cleanCommand } from '../hooks/command-display.mjs';

const root = '/private/tmp/duet14-g-fixture';
const TYPE = 'fugato:codex-native';
const clone = (value: any) => JSON.parse(JSON.stringify(value));
test('command display follows every spec vector without changing shell words', () => {
  const vectors: [string, string, string, string?][] = [
    [String.raw`/bin/zsh -lc "rg -n --hidden -g '!native-captures.mjs' 'codex:|codex@fugato' plugins"`, 'rg', "-n --hidden -g '!native-captures.mjs' 'codex:|codex@fugato' plugins"],
    [String.raw`/bin/zsh -lc 'rg -n -g '"'"'!x'"'"' foo'`, 'rg', "-n -g '!x' foo"],
    [String.raw`/bin/zsh -lc "git -c user.name=Ghqqqq -c user.email=a@b commit -m \"Rename main\""`, 'git', "commit -m 'Rename main'"],
    [String.raw`/bin/zsh -lc "nl -ba plugins/codex-live/hooks/poll.ts | sed -n '1,80p'"`, 'nl', '-ba plugins/codex-live/hooks/poll.ts +1'],
    [String.raw`/bin/zsh -lc "N=/x/node env -u CLAUDE_CONFIG_DIR npm_config_offline=true node --test a.mjs"`, 'node', '--test a.mjs'],
    ['/usr/bin/git status --short', 'git', 'status --short'],
    ['/bin/zsh -lc "cd /work/repo && npm test"', 'cd', '. +1'],
    [String.raw`env -i -u HOME FOO='a b' /bin/bash -l -c 'git -C /work/repo -c x=y status'`, 'git', '-C . status'],
    [String.raw`rg 'a|b' "c;d" a\ b a'bc'"de" 'it'\''s' /home/me/x /work/repository/x`, 'rg', String.raw`'a|b' 'c;d' 'a b' abcde 'it'\''s' ~/x /work/repository/x`],
    ['echo one && echo two || echo three; echo four | cat', 'echo', 'one +4'],
    ["echo $(printf \"a && b\") && node a.mjs", "echo", "'$(printf \"a && b\")' +1"],
    ["echo `printf \"a && b\"` && node a.mjs", "echo", "'`printf \"a && b\"`' +1"],
    ["/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\nPY\"", 'python3', "- <<'PY'", '/x'],
    ["/bin/zsh -lc \"cat > check.mjs <<'EOF'\nimport x\nEOF\"", 'cat', "> check.mjs <<'EOF'", '/x'],
    ['/bin/zsh -lc "npm test 2>&1 | tail -5"', 'npm', 'test 2>&1 +1', '/x'],
    ['/bin/zsh -lc "cd /x\nnpm test"', 'cd', '. +1', '/x'],
    ['/bin/zsh -lc "rg foo < list.txt > out.txt"', 'rg', 'foo < list.txt > out.txt', '/x'],
    ['cat <<EOF > a.txt\nhi\nEOF\necho done', 'cat', '<<EOF > a.txt +1', '/x'],
    ['sort <<< "b a"', 'sort', "<<< 'b a'", '/x'],
    ['cat <<"EOF"\nnot EOF\nEOF\necho done', 'cat', '<<"EOF" +1', '/x'],
    ["cat <<-EOF\n\thi\n\tEOF\necho done", 'cat', '<<-EOF +1', '/x'],
    ["cat <<'A' <<\\B\nbody && hidden\nA\nmore | hidden\nB\necho done", 'cat', "<<'A' <<\\B +1", '/x'],
    ["cat << 'END'\nbody\nEND\n\n echo done\n\n pwd", 'cat', "<< 'END' +2", '/x'],
    ["cat <<'EOF'\nunfinished body && hidden", 'cat', "<<'EOF'", '/x'],
    ['node a.mjs >out.txt >>more.txt <in.txt 2>err.txt 1>&2 0<&3 &>all.txt &>>log.txt >|force.txt',
      'node', 'a.mjs > out.txt >> more.txt < in.txt 2> err.txt 1>&2 0<&3 &> all.txt &>> log.txt >| force.txt', '/x'],
    ['echo hi 2>& 1 && echo done', 'echo', 'hi 2>& 1 +1', '/x'],
    ['rg foo < /x/list.txt > "/x/out file.txt"', 'rg', "foo < list.txt > 'out file.txt'", '/x'],
    [String.raw`echo '>' '<<EOF' '2>&1' \> \|`, 'echo', "'>' '<<EOF' '2>&1' '>' '|'", '/x'],
    ['npm \\\n test\necho done', 'npm', 'test +1', '/x'],
    ['\\\n echo fo\\\no\n\necho done', 'echo', 'foo +1', '/x'],
    ['npm test 2>\\\n&1 |\\\n| echo failed', 'npm', 'test 2>&1 +1', '/x'],
    ['echo "a\nb"\necho done', 'echo', "'a\nb' +1", '/x'],
    ["echo 'a\\\nb'\necho done", 'echo', "'a\\\nb' +1", '/x'],
  ];
  const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
  for (const [raw, verb, args, cwd = '/work/repo'] of vectors) {
    const context = { cwd, home: '/home/me' };
    const actual = cleanCommand(raw, context);
    expect({ raw, verb: actual.verb, args: actual.args }).toEqual({ raw, verb, args });
    // Exercise the native renderer's own quoting too; keep width shortening
    // and literal newlines inside quoted arguments out of this comparison.
    if (cwd === '/x' && verb.length + args.length < 90 && !args.includes('\n')) {
      const row = eventRow({ viewport: { columns: 100 } },
        { kind: 'event', title: `Bash(${raw})`, result: 'Done', running: false }, context);
      expect(plain(row)).toBe(`  ✓ ${verb} ${args}`);
    }
  }
});

test('agent rows use a left status gutter, trailing detail and the full viewport', () => {
  const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
  const nodes = (node: any): any[] => typeof node === 'string' ? [] : [node, ...(node.children ?? []).flatMap(nodes)];
  const view = { name: 'Carnot', role: 'reviewer', model: 'gpt-6-astra', effort: 'xhigh', sandbox: 'read-only',
    cwd: '/work/rc-main', status: 'running', elapsedMs: 105000, pane: true };
  const context = { view, cwd: view.cwd, home: '/home/me' };
  const entries = [
    ...foldEntries(['Bash(rg --files) · Done', 'Bash(git status --short) · Done'].map(logEntry)),
    logEntry('Bash(node --test plugins/codex/tests/native-integration.mjs) · Done (2s)'),
    logEntry('Bash(git diff HEAD -- plugins/codex/hooks/native-agent.mjs) · Done (0.3s)'),
    logEntry('Bash(nl -ba plugins/codex-live/hooks/poll.ts | sed -n 1,80p) · Error: exit 1'),
    logEntry('Update(/work/rc-main/plugins/codex/hooks/native-agent.mjs) · +6 −1'),
    logEntry('Bash(npm test) · running'),
    logEntry('Bash(npm test) · cancelled'),
    logEntry('Bash(node ' + 'word '.repeat(40) + ') · Error: exit 3'),
  ];
  for (let columns = 0; columns <= 200; columns++) {
    const e = { viewport: { columns } }, rows = entries.map(entry => eventRow(e, entry, context));
    const all = [headerRow(e, view), ...logRows(e, logEntry('Codex: I’ll check the native adapter and keep its execution behavior unchanged.'), context).children,
      ...rows, statusRow(e, view)];
    expect(all.every(row => textWidth(plain(row)) <= columns)).toBe(true);
    expect(all.some(row => plain(row).includes('  › ') || /[└⎿] Done/.test(plain(row)))).toBe(false);
    expect(nodes({ children: all }).filter(node => node.props?.color).every(node =>
      ['text', 'subtle', 'inactive', 'success', 'error', 'warning', 'claude', 'suggestion', 'diffAdded', 'diffRemoved'].includes(node.props.color))).toBe(true);
    if (columns >= 60) {
      expect(plain(rows[0])).toBe('  ✓ explored 2 commands · rg, git');
      expect(plain(rows[1])).toMatch(/^  ✓ .* · 2s$/);
      expect(plain(rows[2])).toMatch(/^  ✓ /);
      expect(plain(rows[2])).not.toContain(' · ');
      expect(plain(rows[3])).toMatch(/^  ✗ .* · exit 1$/);
      expect(plain(rows[4])).toMatch(/^  ✓ edit .*  \+6 −1$/);
      expect(plain(rows[5])).toBe('  ● npm test · running 1m 45s');
      expect(plain(rows[6])).toBe('  ■ npm test · cancelled');
      expect(plain(rows[7])).toMatch(/^  ✗ node .*… · exit 3$/);
      expect(plain(headerRow(e, view))).toBe('Carnot · reviewer · astra xhigh · read-only · rc-main');
      expect(plain(statusRow(e, view))).toBe('running · 1m 45s · /fugato-live Carnot');
    }
  }
  const coloured = entries.map(entry => eventRow({ viewport: { columns: 120 } }, entry, context));
  for (const [index, glyph, color] of [[0, '✓', 'success'], [3, '✗', 'error'], [5, '●', 'claude'], [6, '■', 'inactive']] as const) {
    expect(nodes(coloured[index]).some(node => node.props?.color === color && plain(node) === glyph)).toBe(true);
  }
  for (const [index, detail, color] of [[1, ' · 2s', 'subtle'], [3, ' · exit 1', 'error'],
    [5, ' · running 1m 45s', 'claude'], [6, ' · cancelled', 'inactive'], [4, '+6', 'diffAdded'], [4, '−1', 'diffRemoved']] as const) {
    expect(nodes(coloured[index]).some(node => node.props?.color === color && plain(node) === detail)).toBe(true);
  }
  const pathRow = (columns: number, text: string) => plain(eventRow({ viewport: { columns } }, logEntry(text), context));
  expect([
    pathRow(100, 'Bash(node --test plugins/codex/tests/native-integration.mjs) · Done (2m 44s)'),
    pathRow(60, 'Bash(node --test plugins/codex/tests/native-integration.mjs) · Done (2m 44s)'),
    pathRow(100, 'Update(plugins/codex/scripts/codex-companion.mjs) · +6 −1'),
  ]).toEqual([
    '  ✓ node --test plugins/codex/tests/native-integration.mjs · 2m 44s',
    '  ✓ node --test …/tests/native-integration.mjs · 2m 44s',
    '  ✓ edit plugins/codex/scripts/codex-companion.mjs  +6 −1',
  ]);
  const status = (text: string, extra = {}) => plain(eventRow({ viewport: { columns: 60 } }, logEntry(text), { ...context, ...extra })).trimEnd();
  expect(status('Bash(npm test) · running')).toMatch(/ running 1m 45s$/);
  expect(status('Bash(npm test) · running', { interruption: 'cancelled' })).toMatch(/ cancelled$/);
  expect(status('Bash(npm test) · Error')).toBe('  ✗ npm test · error');
  expect(status('Bash(npm test) · exit unknown')).toBe('  ! npm test · exit ?');
  expect(status('Bash(npm test) · Done (2m 5s)')).toBe('  ✓ npm test · 2m 5s');
  expect(plain(eventRow({ viewport: { columns: 100 } }, logEntry('Bash(node ' + 'a'.repeat(50) + '🇺🇸🇨) · Done'), context)))
    .toContain("'" + 'a'.repeat(24) + '…' + 'a'.repeat(11) + "🇺🇸🇨'");
  const final = proseRows({ viewport: { columns: 28 } }, '**Renamed** the plugin and kept `DUET:` unchanged.', { marker: 'success', limit: 12 });
  expect(final.every(row => plain(row).startsWith('▏') && textWidth(plain(row)) <= 28)).toBe(true);
  expect(nodes({ children: final }).some(node => node.props?.bold && plain(node) === 'Renamed')).toBe(true);
  expect(final.every(row => row.children[0].children[0].props.color === 'success')).toBe(true);
  expect(['first\rsecond', 'first\r\nsecond'].map(text =>
    proseRows({ viewport: { columns: 60 } }, text, { marker: 'success' }).map(plain)))
    .toEqual([['▏first', '▏second'], ['▏first', '▏second']]);
  const compound = status('Bash(node ' + 'a'.repeat(100) + ' b'.repeat(20) + ' && npm test) · Done');
  expect(compound).toMatch(/^  ✓ .*… \+1$/);
  expect(proseRows({ viewport: { columns: 120 } }, 'a'.repeat(115)).map(plain)).toEqual(['a'.repeat(115)]);
  expect(plain(logRows({ viewport: { columns: 120 } }, { kind: 'question', title: 'Which branch?' })))
    .toBe('  ? asks Claude · Which branch?');
  expect(plain(logRows({}, logEntry('Codex: [completed] Final summary.')))).toBe('');
  expect(plain(logRows({}, logEntry('Codex: [needs_input] Choose a branch.')))).toBe('');
  expect(plain(logRows({}, logEntry('Codex: [notes] Ordinary progress.')))).toBe('[notes] Ordinary progress.');
  expect(plain(logRows({ viewport: { columns: 60 } }, logEntry('Write(/work/rc-main/new.mjs) · +2 −0'), context)).trimEnd()).toBe('  ✓ edit new.mjs  +2');
  expect(logEntry('└ Done (0.0s)')).toBe(null);
  expect(logEntry('⎿ Done')).toBe(null);
});

test('report blocks preserve summary lines, ordered facts, colours and the sixty-row budget', () => {
  const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
  const nodes = (node: any): any[] => typeof node === 'string' ? [] : [node, ...(node.children ?? []).flatMap(nodes)];
  const report = { status: 'completed', worker: 'Benett', jobId: 'task-display',
    summary: 'Updated the native view.\n\nKept the report readable.\n- Preserved line breaks.\n- Added bounded facts.',
    changedFiles: ['src/view.mjs', 'notes.txt', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'],
    checks: { ran: Array(7).fill('hidden raw command'), omitted: 2, failed: 2,
      claimed: ['fixture check: passed', 'manual check: passed', 'display check: passed', 'fourth claim', 'fifth claim'] },
    keyFindings: ['Commands keep their status glyphs.', 'Reports end with one status line.'],
    assumptions: ['hidden assumption'], next: 'SendMessage to Benett to continue', details: 'fugato result task-display --details',
    usage: { totalTokens: 200000, inputTokens: 180000 } };
  const question = { ...report, status: 'needs_input', summary: 'A branch choice is needed.',
    changedFiles: [], checks: undefined, keyFindings: [], usage: undefined,
    blockers: [{ code: 'branch_required', message: 'Choose a destination branch.' }],
    question: { text: 'Which branch should I use?', options: ['main', 'rc-int'] } };
  const input = JSON.stringify(report);
  for (let columns = 0; columns <= 200; columns++) {
    for (const value of [report, question, { ...report, summary: Array(90).fill('More summary.').join('\n') }]) {
      const rows = reportMarkdown({ text: JSON.stringify(value) }, { viewport: { columns } }).children;
      expect(rows.length <= 60).toBe(true);
      expect(rows.every((row: any) => textWidth(plain(row)) <= columns)).toBe(true);
    }
  }
  const drawn = reportMarkdown({ text: input }, { viewport: { columns: 120 } });
  const rows = drawn.children.map(plain);
  expect(rows.slice(0, 6)).toEqual(['▏Updated the native view.', '▏', '▏Kept the report readable.',
    '▏- Preserved line breaks.', '▏- Added bounded facts.', ' ']);
  expect(rows.filter((row: string) => /^  [a-z]/.test(row)).map((row: string) => row.slice(2, 12).trim()))
    .toEqual(['changed', 'checks', 'claimed', 'findings']);
  expect(rows.find((row: string) => row.startsWith('  changed'))).toContain('src/c.mjs · +2 more');
  expect(rows).toContain('  checks    9 passed · 2 failed');
  expect(rows).toContain('            +2 more');
  expect(rows.slice(-2)).toEqual([' ', 'done · 200k tokens']);
  expect(nodes(drawn).some(node => node.props?.color === 'error' && plain(node) === '2 failed')).toBe(true);
  expect(nodes(drawn).some(node => node.props?.color === 'subtle' && plain(node) === 'src/')).toBe(true);
  expect(nodes(drawn).some(node => node.props?.color === 'text' && plain(node) === 'view.mjs')).toBe(true);
  expect(rows.join('\n')).not.toMatch(/hidden|Checks run|provider:|SendMessage|details|job task/);
  const asked = reportMarkdown({ text: JSON.stringify(question) }, { viewport: { columns: 60 } });
  expect(asked.children.map(plain).slice(-4)).toEqual(['  question  Which branch should I use?',
    '            1. main  2. rc-int', ' ', 'asks Claude']);
  expect(nodes(asked).some(node => node.props?.color === 'warning' && plain(node) === 'Which branch should I use?')).toBe(true);
  const passed = reportMarkdown({ text: JSON.stringify({ ...question, checks: { ran: ['check'], failed: 0 } }) });
  expect(passed.children.map(plain)).toContain('  checks    1 passed');
  expect(JSON.stringify(report)).toBe(input);
  expect(reportMarkdown({ text: input, isSummary: true })).toBe(null);
});
// Migrate only the two captured usage labels; preserve the recorded execution.
const captures = recordedCaptures.map(capture => {
  const started = capture.notices.find((notice: any) => notice.message.content[0].text.includes('started · job '));
  const model = started?.message.content[0].text.match(/ · ([^ ]+) \/ /)?.[1] ?? 'unknown';
  return JSON.parse(JSON.stringify(capture)
    .replaceAll('Codex usage · 150 input (40 cached) · 30 output tokens',
      `Codex tokens (provider: OpenAI Codex, model ${model}) · 150 input · 40 cached · 30 output · 180 total`)
    .replaceAll('Codex usage · 12,345 input (8,000 cached) · 678 output tokens',
      `Codex tokens (provider: OpenAI Codex, model ${model}) · 12,345 input · 8,000 cached · 678 output · 13,023 total`));
});
async function drain(stream: any) {
  const chunks = []; let item;
  do { item = await stream.next(); if (!item.done) chunks.push(item.value); } while (!item.done);
  return { chunks, result: item.value };
}

// A held companion keeps a real native flight open while ancillary work fails.
// Advance timer callbacks independently, as the host does, without resolving
// the held lookup until after observing the live stream.
async function faultKeepalives(fault: 'append' | 'lookup' | 'queue' | 'owner-append' | 'owner-save') {
  const capture: any = captures[3], hooks = new Map(), store = new Map(), timers = new Set<any>();
  const on: any = (name: string, matcher: any, handler: any) => {
    hooks.set(name, typeof matcher === 'function' ? matcher : handler);
    return { catch() {} };
  };
  registerNative(on);
  let now = 1800000000000, releaseOwner!: () => void, releaseLookup!: () => void, faultActive = true;
  let injected = false, consumed = false, earlyClose = false, logs = 0;
  const owner = new Promise<void>(resolve => { releaseOwner = resolve; });
  const lookup = new Promise<void>(resolve => { releaseLookup = resolve; });
  const notices: any[] = [], chunks: any[] = [];
  const state = { type: TYPE, session: 'native-session', agentId: 'native-agent', name: 'native-worker',
    v: 2, cwd: root + '/repo', permissionMode: 'default', incoming: { turnId: 'turn-1', text: 'Held fixture task.' } };
  store.set('native:v2:native-session:native-agent', state);
  const timer = (ms: number, fn: any, once = false) => {
    const item = { ms, fn, once, due: now + ms }; timers.add(item);
    return { cancel: () => timers.delete(item) };
  };
  const $: any = {
    plugin: { root: '/plugin' }, ui: { invalidate() {}, log() { logs++; } }, env: { get: async () => undefined },
    session: { id: async () => 'native-session', root: async () => root + '/repo', append: async (row: any) => {
      if (faultActive && fault === 'append' && notices.length) return { deny: 'Fixture refusal' };
      if (!faultActive && fault === 'owner-append' && !injected) { injected = true; return { deny: 'Fixture refusal' }; }
      notices.push(clone(row)); return {};
    } },
    agent: { list: async () => [{ id: 'native-agent', name: 'native-worker', type: TYPE }] },
    store: { get: async (key: string) => clone(store.get(key) ?? null),
      set: async (key: string, value: any) => {
        if (!faultActive && fault === 'owner-save' && !injected && value.notices?.count > noticesBeforeOwner) {
          injected = true; throw new Error('Fixture progress save failure');
        }
        store.set(key, clone(value));
      } },
    clock: { now: async () => now, every: (ms: number, fn: any) => timer(ms, fn), after: (ms: number, fn: any) => timer(ms, fn, true) },
    process: { run: async (argv: string[], init: any) => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: '/host/node\n' };
      expect(argv[2]).toBe('status');
      expect(init.timeoutMs > 0 && init.timeoutMs <= 15000).toBe(true);
      if (faultActive && fault === 'lookup') await lookup;
      return capture.processes.find((p: any) => p.kind === 'run' && p.request.argv[2] === 'status'
        && (p.request.argv[3] === '--all') === (argv[3] === '--all')).value;
    }, spawn: (request: any) => {
      const command = request.argv[2];
      const record = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === command
        && (command !== 'status' || (p.request.argv[3] === '--all') === (request.argv[3] === '--all')));
      const stream = (async function* () {
        if (command === 'task') await owner;
        try {
          if (command === 'task' && fault.startsWith('owner-')) yield { stream: 'stdout', text: '[0] Owner progress\n' };
          for (const chunk of record.chunks) yield chunk;
          if (command === 'task') consumed = true;
        } finally { if (command === 'task' && !consumed) earlyClose = true; }
      })();
      return Object.assign(stream, { result: Promise.resolve({ code: 0 }) });
    } },
  };
  const stream = hooks.get('turn.step')($, { agentId: 'native-agent', turnId: 'turn-1', index: 0 }, () => { throw new Error('Unexpected model'); });
  let resumeReader!: () => void, heartbeatPending = 0, maxHeartbeatPending = 0;
  const readerGate = new Promise<void>(resolve => { resumeReader = resolve; });
  const pending = (async () => {
    let item;
    do {
      item = await stream.next();
      if (!item.done) chunks.push(item.value);
      if (fault === 'queue' && faultActive) await readerGate;
    } while (!item.done);
    return item.value;
  })();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const advance = async (offset: number) => {
    now = 1800000000000 + offset;
    for (const item of [...timers].sort((a, b) => a.due - b.due)) if (item.due <= now) {
      if (item.once) timers.delete(item); else item.due = now + item.ms;
      if (item.ms === 30000) heartbeatPending++;
      void Promise.resolve(item.fn()).catch(() => {}).finally(() => {
        if (item.ms === 30000) heartbeatPending--;
      });
    }
    await settle();
    maxHeartbeatPending = Math.max(maxHeartbeatPending, heartbeatPending);
  };
  let observed, noticesBeforeOwner = 0;
  try {
    await settle();
    await advance(1500);
    let liveUpdates = 0;
    for (let tick = 1; tick <= (fault === 'queue' ? 500 : 24); tick++) {
      const before = chunks.length;
      await advance(tick * 30000);
      if (tick > 1 && chunks.length > before) liveUpdates++;
    }
    observed = fault === 'queue' ? { maxHeartbeatPending, heartbeatPending }
      : { thinking: chunks.filter(chunk => chunk.kind === 'thinking').length,
        notices: notices.length, finalChunks: chunks.filter(chunk => chunk.kind !== 'thinking').length, liveUpdates };
  } finally {
    noticesBeforeOwner = notices.length;
    faultActive = false; resumeReader(); releaseLookup(); releaseOwner();
    const result = await pending;
    expect({ fault, report: JSON.parse(result.answer) }).toEqual({ fault, report: expect.objectContaining({ status: 'completed' }) });
    expect(timers.size).toBe(0);
  }
  if (fault.startsWith('owner-')) return { injected, consumed, earlyClose, logged: logs > 0 };
  return observed;
}

// Exercise append/start orderings, independently minted coordinator echoes,
// normalized render ids, identical briefs, and overlapping command titles.
async function displayReplay(exercise?: (api: any) => Promise<void>) {
  const hooks = new Map(), store = new Map(), engine = { type: 'engine', ref: 0 };
  registerNative((name: string, matcher: any, handler: any) => {
    const key = name === 'ui.render' ? matcher.component : name;
    const callback = typeof matcher === 'function' ? matcher : handler;
    hooks.set(key, callback);
    return { catch(fallback: any) {
      if (name === 'ui.render') hooks.set(key, async (...args: any[]) => {
        try { return await callback(...args); } catch { return fallback(...args); }
      });
    } };
  });
  const capture: any = captures[3], text = 'Identical native brief.';
  let current: any, phaseTrees: any[] = [], summaryTrees: any[] = [], forwarded: any, columns = 120, now = 1800000000000;
  const renderAccess: string[] = [];
  const renderHost = new Proxy({}, { get(_, key) { renderAccess.push(String(key)); throw new Error('Render must use display state only'); } });
  const $: any = {
    plugin: { root: '/plugin' }, ui: { invalidate() {} }, env: { get: async () => undefined },
    session: { id: async () => 'native-session', root: async () => root + '/repo', append: async () => ({}) },
    fs: { stat: async (path: string) => ({ kind: 'dir', realPath: path }) },
    agent: { list: async () => [{ id: current.agentId, name: current.agentId, type: TYPE }] },
    store: { delete: async (key: string) => { store.delete(key); }, get: async (key: string) => clone(store.get(key) ?? null), set: async (key: string, value: any) => { store.set(key, clone(value)); } },
    clock: { now: async () => now, every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) },
    process: { run: async (argv: string[], init: any) => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: '/host/node\n' };
      expect(argv[2]).toBe('status');
      expect(init.timeoutMs > 0 && init.timeoutMs <= 15000).toBe(true);
      const value = capture.processes.find((p: any) => p.kind === 'run' && p.request.argv[2] === 'status'
        && (p.request.argv[3] === '--all') === (argv[3] === '--all')).value;
      return { ...value, stdout: value.stdout.replaceAll('native-session:native-agent:turn-1',
        `native-session:${current.agentId}:${current.turnId}`) };
    }, spawn: (request: any) => {
      const command = request.argv[2];
      const record = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === command
        && (command !== 'status' || (p.request.argv[3] === '--all') === (request.argv[3] === '--all')));
      const stream = (async function* () {
        if (command === 'task') for (const line of current.lines) {
          yield { stream: 'stdout', text: `[0] ${line}\n` };
          phaseTrees.push(await render(current.requestId, current.kind, current.text));
          if (exercise) summaryTrees.push(await hooks.get('ToolUse')(renderHost, { component: 'ToolUse', surface: 'terminal',
            viewport: { columns }, props: { tool: 'Agent', tool_use_id: current.uuid, input: { subagent_type: TYPE } } }, async () => engine));
        }
        if (command === 'task') now += current.elapsedMs || 0;
        for (const chunk of record.chunks) {
          let text = chunk.text.replaceAll('native-session:native-agent:turn-1', `native-session:${current.agentId}:${current.turnId}`);
          if (command === 'task' && chunk.stream === 'stdout' && current.report) text = text.split('\n').map((line: string) => {
            try { const value = JSON.parse(line); return value.status ? JSON.stringify({ ...value, ...current.report }) : line; }
            catch { return line; }
          }).join('\n');
          yield { ...chunk, text };
        }
      })();
      return Object.assign(stream, { result: Promise.resolve({ code: 0 }) });
    } },
  };
  const render = async (uuid: string, kind = 'unclassified', body = text, isExpanded = true) => {
    const input = { component: 'UserMessage', surface: 'terminal', requestId: uuid, viewport: { columns },
      props: { text: body, origin: { kind }, isExpanded } };
    const original = clone(input);
    let drawing: any;
    const tree = await hooks.get('UserMessage')(renderHost, input, async (e: any) => { drawing = forwarded = clone(e); return engine; });
    expect(input).toEqual(original);
    expect(drawing).toEqual({ ...original, props: { ...original.props, text: drawing.props.text } });
    return tree;
  };
  let appendCalls = 0;
  const append = async (uuid: string, agentId?: string, door = 'prompt', body = text, plain = false) => {
    const input = { uuid, agentId, door, origin: { kind: plain ? 'coordinator' : agentId ? 'unclassified' : 'composer' },
      message: { type: 'user', content: plain ? body : [{ type: 'text', text: body }] } };
    const result = { uuid, message: input.message };
    const next = async (e: any) => { expect(e).toEqual(input); appendCalls++; return result; };
    expect(await (hooks.has('session.append') ? hooks.get('session.append')($, input, next) : next(input))).toEqual(result);
  };
  const run = async (agentId: string, turnId: string, before: boolean, lines: string[], body = text, appended = body, plain = false,
    row: { uuid?: string, echo?: boolean, append?: boolean, report?: any, elapsedMs?: number } = {}) => {
    const uuid = row.uuid ?? `${agentId}:${turnId}`;
    current = { agentId, turnId, uuid, requestId: row.echo ? `${uuid}-echo` : uuid,
      kind: row.echo ? 'coordinator' : 'unclassified', lines, text: body, report: row.report, elapsedMs: row.elapsedMs };
    // plain: like a SendMessage follow-up, the row's content is a string and
    // turn.start receives the same framed text.
    const started = plain ? appended : body;
    store.set(`native:v2:native-session:${agentId}`, { type: TYPE, session: 'native-session', agentId, name: agentId,
      v: 2, cwd: root + '/repo', permissionMode: 'default', incoming: { turnId, text: started } });
    if (exercise) {
      await hooks.get('agent.spawn')($, { subagentType: TYPE, tool_use_id: current.uuid }, async () => ({ agentId }));
      store.delete(`native:binding-failed:v1:native-session:${agentId}`);
    }
    const write = (body: string) => row.append === false ? Promise.resolve() : append(current.uuid, agentId, 'prompt', body, plain);
    if (before) await write(appended);
    await hooks.get('classic.SubagentStart')($, { session_id: 'native-session', agent_id: agentId, agent_type: TYPE }, async () => ({}));
    await hooks.get('turn.start')($, { agentId, turnId, text: started }, async () => ({ turnId }));
    if (!before) await write(body);
    // A replayed row must not steal the next turn's binding.
    await write(body);
    phaseTrees = []; summaryTrees = [];
    const result = await drain(hooks.get('turn.step')($, { agentId, turnId, index: 0 }, () => { throw new Error('Unexpected model'); }));
    const report = JSON.parse(result.result.answer), requestId = current.requestId, kind = current.kind;
    expect({ agentId, turnId, report }).toEqual({ agentId, turnId, report: expect.objectContaining({ status: row.report?.status || 'completed' }) });
    return { tree: clone(await render(requestId, kind, body)), phases: clone(phaseTrees), summaries: clone(summaryTrees), report,
      redraw: () => render(requestId, kind, body),
      drawReport: (fields = {}) => hooks.get('AssistantMessage')(renderHost, { component: 'AssistantMessage', viewport: { columns },
        props: { text: JSON.stringify({ ...report, ...fields }) } }, async () => engine),
      spinner: () => hooks.get('Spinner')(renderHost, { requestId: agentId, viewport: { columns } }, async () => engine) };
  };
  await append('parent');
  const first = await run('agent-a', 'turn-1', true,
    ['Bash(same) · running', 'Bash(same) · running', 'Bash(same) · Done (1s)', 'Bash(same) · Done (1s)']);
  const parent = await render('parent', 'composer'), unidentified = await render('unidentified');
  const second = await run('agent-b', 'turn-1', false, ['Codex: second agent']);
  const firstRetained = JSON.stringify(await render('agent-a:turn-1')) === JSON.stringify(first.tree);
  const frame = (body: string) => `The coordinator sent a message while you were working:\n${body}\n\nAddress this before completing your current task.`;
  // The appended coordinator row is hidden. Its visible echo has a separate
  // id and bare text, while turn.start receives the full framed text.
  const followup = await run('agent-a', 'turn-2', true, ['Codex: follow-up'], text,
    frame(text), true, { echo: true });
  const followupLog = JSON.stringify(followup.tree) === JSON.stringify(await render('agent-a:turn-2', 'coordinator', text));
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const normalized = await run('agent-normalized', 'turn-1', true, ['Codex: normalized id'], text, text, false, { uuid });
  const normalizedId = normalized.tree.type === 'Box'
    && JSON.stringify(await render(uuid.slice(0, 24) + '000000000001')) === JSON.stringify(normalized.tree);
  await run('agent-prefix-collision', 'turn-1', true, ['Codex: colliding prefix'], text, text, false,
    { uuid: uuid.slice(0, 24) + 'bbbbbbbbbbbb' });
  const ambiguousPrefix = await render(uuid.slice(0, 24) + '000000000001');
  const repeated = 'Identical follow-up message.';
  // The same text cannot identify either turn, even within one agent. Both
  // echoes must stay undecorated when the newer row renders first.
  await run('agent-repeat', 'turn-1', true, ['Codex: first repeat'], repeated, frame(repeated), true);
  await run('agent-repeat', 'turn-2', true, ['Codex: second repeat', 'Codex: another entry'], repeated, frame(repeated), true);
  const nonCoordinator = await render('repeat-unclassified', 'unclassified', repeated);
  const unmatchedCoordinator = await render('unmatched-coordinator', 'coordinator', 'No recorded turn matches this message.');
  const echoOrder = [await render('repeat-echo-2', 'coordinator', repeated), await render('repeat-echo-1', 'coordinator', repeated)];
  // Re-rendering in chronological order must not resolve that ambiguity.
  const echoRetained = [await render('repeat-echo-1', 'coordinator', repeated), await render('repeat-echo-2', 'coordinator', repeated)];
  const extraEcho = await render('repeat-echo-3', 'coordinator', repeated);
  // Once the framed turn is consumed, identical bare first-turn text must
  // never supply another coordinator echo's log.
  const bareFallback = await render('bare-echo', 'coordinator', text);
  const unappended = await run('agent-unappended', 'turn-1', true, ['Codex: unappended'], 'Unappended follow-up.',
    frame('Unappended follow-up.'), true, { echo: true, append: false });
  const oldTurnsRetained = [first, second].map((value, i) =>
    render(`${i ? 'agent-b' : 'agent-a'}:turn-1`).then((tree: any) => JSON.stringify(tree) === JSON.stringify(value.tree)));
  const plainText = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plainText).join('');
  const events = (tree: any) => (tree.children ?? []).filter((row: any) => row.props?.flexDirection === 'column' && /^  [✓✗●■!]/.test(plainText(row)));
  const phases = first.phases.map(tree => events(tree).map((entry: any) => entry.children[0].children[0].children.find((node: any) => /^(?:✓|✗|●)/.test(node.children?.[0])).props.color));
  const observed = { parent, unidentified, decorated: [first, second, followup].map(value => value.tree.type === 'Box'),
    firstRetained, oldTurnsRetained: await Promise.all(oldTurnsRetained), phases, appendCalls,
    binding: { followupLog, normalizedId, ambiguousPrefix, nonCoordinator, unmatchedCoordinator, echoOrder, echoRetained, extraEcho,
      bareFallback, unappended: unappended.tree.type === 'Box' } };
  const brief = '\nKeep this brief.\n\n  Preserve its indentation.\n';
  const header = "DUET: --model=gpt-6-astra --effort xhigh --fast --sandbox read-only --cwd '/very/long/absolute path/int-145/'\r\n";
  const projected = await run('agent-header', 'turn-1', true, ['Codex: header fixture'], header + brief);
  expect(forwarded.props.text).toBe(brief);
  const nodes = (tree: any): any[] => typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : [];
  const plain = await render(current.uuid, 'unclassified', brief);
  expect(forwarded.props.text).toBe(brief);
  const collapsed = await render(current.uuid, 'unclassified', header + brief, false);
  expect({ expanded: projected.tree.children[1], collapsed: collapsed.children[1].children[0].children.map((node: any) => node.children[0]) })
    .toEqual({ expanded: engine, collapsed: ['Claude › ', 'Keep this brief.'] });
  const nonNative = await render('unidentified', 'unclassified', header + brief);
  expect(forwarded.props.text).toBe(header + brief);
  const invalid = 'DUET: --unsupported\n' + brief;
  const fallback = await render(current.uuid, 'unclassified', invalid);
  expect(forwarded.props.text).toBe(invalid);
  if (exercise) await exercise({ run, setColumns: (value: number) => { columns = value; },
    setPane: () => { $.command = { list: async () => [{ name: 'fugato-live' }] }; },
    setHome: (value: string) => { $.env.get = async (name: string) => name === 'HOME' ? value : undefined; } });
  const shared = 'Same follow-up for different agents.';
  await run('agent-ambiguous-a', 'turn-1', true, ['Codex: first candidate'], shared, frame(shared), true);
  await run('agent-ambiguous-b', 'turn-1', true, ['Codex: second candidate', 'Codex: another entry'], shared, frame(shared), true);
  const ambiguous = [await render('ambiguous-echo-1', 'coordinator', shared), await render('ambiguous-echo-2', 'coordinator', shared)];
  // Expire only the older candidate through the 256-turn retention boundary.
  // Losing history cannot identify the old echo, so it must remain unbound.
  // These starts record display history without running any additional jobs.
  for (let i = 0; i < 255; i++) {
    const turnId = `retention-${i}`, agentId = 'agent-ambiguous-b', text = 'Unrelated retention fixture.';
    const key = `native:v2:native-session:${agentId}`;
    store.set(key, { ...store.get(key), incoming: { turnId, text } });
    await hooks.get('turn.start')($, { agentId, turnId, text }, async () => ({ turnId }));
  }
  const ambiguityResolved = await render('ambiguous-echo-1', 'coordinator', shared);
  const ambiguityConsumed = await render('ambiguous-echo-3', 'coordinator', shared);
  return { ...observed, ambiguity: { ambiguous, resolved: ambiguityResolved, consumed: ambiguityConsumed }, projection: {
    hostNodes: nodes(projected.tree).filter(node => node.type === 'engine').length,
    promptAndLogKept: nodes(plain).every(node => nodes(projected.tree).some(other => JSON.stringify(node) === JSON.stringify(other)) || node === plain),
    nonNative, fallback, renderAccess
  } };
}

function fixture(on: any, observeProgress?: (notices: any) => Promise<void>) {
  let agents: any[] = [], store = new Map(), processes: any[] = [], expectedPrompt: string;
  let permissionMode = 'unknown';
  let modelCalls = 0, calls = 0, listFailure = false, processFailure = false, getFailure = false, missingNode = false;
  let sessionId = 'native-session';
  const problems: string[] = [];
  mock.env(on, {});
  const clock = mock.clock(on, { now: 1800000000000 });
  const transcript = mock.session(on);
  on('fs.stat', (_: any, e: any) => ({ value: { kind: 'dir', realPath: e.path } }));
  on('store.keys', () => ({ value: [...store.keys()] }));
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined }; });
  on('session.id', () => ({ value: sessionId }));
  on('session.cwd', () => ({ value: root + '/repo' }));
  on('session.root', () => ({ value: root + '/repo' }));
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context, origin: e.origin }));
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Intro', scope: 'shared' }] }));
  on('store.get', (_: any, e: any) => {
    if (getFailure) { getFailure = false; throw new Error('Injected hook failure'); }
    return { value: store.get(e.key) };
  });
  on('store.set', (_: any, e: any) => {
    store.set(e.key, clone(e.value));
    // Observe admission while its producer is suspended, without changing
    // replay chunks or depending on how quickly the turn stream is drained.
    if (observeProgress && e.value.notices?.count) return observeProgress(clone(e.value.notices)).then(() => ({ value: undefined }));
    return { value: undefined };
  });
  on('agent.list', () => {
    if (listFailure) throw new Error('Injected agent-list failure');
    return { value: agents };
  });
  on('classic.SubagentStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  on('agent.spawn', (_: any, e: any) => {
    if (e.subagentType === TYPE) {
      permissionMode = e.permissionMode ?? 'unknown';
      expect(e.prompt).toBe(expectedPrompt);
      agents = [{ id: 'native-agent', type: TYPE, name: e.name, description: e.description, status: 'running' }];
    }
    return { model: 'haiku', agentId: 'native-agent' };
  });
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }));
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }));
  on('turn.step', async function* (_: any, e: any) {
    modelCalls++;
    yield { kind: 'text', index: 0, text: 'unchanged model bottom' };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { turnId: e.turnId, index: e.index, answer: 'unchanged model bottom',
      stopReason: 'end_turn', toolUses: [], usage: null };
  });
  function take(kind: string, request: any) {
    calls++;
    const expected = processes.shift();
    const normalized = clone(request);
    // Historical captures predate internal permission context. Assert its
    // exact host values, then compare the unchanged legacy request. Fresh
    // integration captures contain these fields and are compared in full.
    if (expected && !expected.request.argv.includes('--claude-permission-mode') && normalized.argv.includes('--claude-permission-mode')) {
      const at = normalized.argv.indexOf('--claude-permission-mode');
      expect(normalized.argv.slice(at, at + 4)).toEqual(['--claude-permission-mode', permissionMode, '--native-cwd', root + '/repo']);
      normalized.argv.splice(at, 4);
    }
    // The engine supplies this checkout's plugin root; capture paths are portable.
    if (normalized.argv[1]?.endsWith('/plugins/codex/scripts/codex-companion.mjs') && normalized.argv[2] === 'reserve-name') {
      if (normalized.argv[0] !== 'node') normalized.argv[0] = '/host/node';
      normalized.argv[1] = '/plugin/scripts/codex-companion.mjs';
    } else if (normalized.argv[0] !== 'node') {
      if (!normalized.argv[1].endsWith('/plugins/codex/bin/fugato')) problems.push('Wrong launcher');
      normalized.argv[0] = '/host/node';
      normalized.argv[1] = '/plugin/bin/fugato';
    } else if (normalized.argv[1]?.endsWith('/plugins/codex/scripts/lib/report-delivery.mjs') && normalized.argv[2] === '--mark-emitted') {
      normalized.argv[1] = '/plugin/scripts/lib/report-delivery.mjs';
    }
    if (!expected || expected.kind !== kind || JSON.stringify(expected.request) !== JSON.stringify(normalized)) {
      // Structural comparison below also ignores harmless key order differences.
      try { expect({ kind, request: normalized }).toEqual({ kind: expected?.kind, request: expected?.request }); }
      catch (e) { problems.push(String(e)); throw e; }
    }
    return expected;
  }
  on('process.spawn', async function* (_: any, e: any) {
    if (processFailure) throw new Error('Injected process failure');
    const record = take('spawn', e);
    for (const step of record.timeline || record.chunks.map((chunk: any) => ({ chunk }))) {
      if (step.advance) await clock.advance(step.advance);
      else yield step.chunk;
    }
    // The test engine skips a throwing mock instead of rejecting the caller
    // with its error. Carry the captured rejection through the companion's
    // error envelope so the adapter catches the same message. The integration
    // fixture exercises the actual rejected stream and aborted turn signal.
    if (record.error) yield { stream: 'stdout', text: '\n' + JSON.stringify({ status: 'error', summary: record.error }) + '\n' };
    // A rejected stream supplied no CLI return value. Do not turn this mock
    // envelope into structural evidence of an exited companion's rejection.
    return { value: record.error ? { ...record.exit, code: null } : record.exit };
  });
  on('process.run', (_: any, e: any) => {
    // Native captures contain only the native prompt handler. The separate
    // report-delivery host contract exercises the composer lookup itself.
    const argv = [...e.argv];
    if (argv[1]?.endsWith('/plugins/codex/scripts/lib/report-delivery.mjs')) argv[1] = '/plugin/scripts/lib/report-delivery.mjs';
    if (JSON.stringify(argv) === JSON.stringify(['node', '/plugin/scripts/lib/report-delivery.mjs', '--claim-unreported'])) {
      return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    }
    return { value: missingNode
      ? { exitCode: 127, stdout: '', stderr: 'Node unavailable', isStdoutTruncated: false, isStderrTruncated: false }
      : take('run', e).value };
  });
  return {
    notices: () => transcript.appended(),
    async replay($: any, capture: any, discoveryDown = false) {
      const replayedChunks: any[] = [];
      store = new Map(); processes = clone(capture.processes); agents = [];
      listFailure = discoveryDown;
      if (discoveryDown) {
        await $.classic.SubagentStart({ session_id: sessionId, agent_id: 'native-agent', agent_type: TYPE });
        // The observed Agent spawn retains the explicit name even when list
        // discovery is unavailable; replay the same name and dispatch argv.
      }
      for (let index = 0; index < capture.events.length; index++) {
        const event = capture.events[index];
        if (event.event === 'reload') { store = new Map(Object.entries(clone(event.store))); continue; }
        if (event.event === 'agent.spawn') expectedPrompt = capture.events[index + 1].input.text;
        const [noun, verb] = event.event.split('.');
        // The replay host cannot unload one module mid-case. Its node resolution
        // is cached; consume only the captured reload's identical prerequisite probe.
        if (event.event === 'turn.step' && processes[0]?.request.argv[0] === 'node' && calls > 0) {
          const probe = processes.shift(); expect(probe.value.stdout).toBe('/host/node\n');
        }
        if (event.event === 'turn.step') {
          const { chunks, result } = await drain($[noun][verb](event.input));
          replayedChunks.push(...chunks);
          expect(chunks).toEqual(event.chunks);
          expect(result).toEqual(event.result);
        } else expect(await $[noun][verb](event.input)).toEqual(event.result);
        if (event.event === 'turn.start') {
          const { agentId, turnId, text } = event.input;
          await $.session.append({ uuid: `${agentId}:${turnId}`, agentId, door: 'prompt', origin: { kind: 'unclassified' },
            message: { type: 'user', content: [{ type: 'text', text }] } });
        }
      }
      // Host prompt rows above are fixture input; captured plugin notices must
      // still match byte for byte, with no additional durable plugin output.
      expect(transcript.appended().filter((row: any) => row.door !== 'prompt')
        .map((row: any) => ({ agentId: row.agentId, message: { type: row.message.type, content: row.message.content } }))).toEqual(capture.notices);
      expect(processes).toHaveLength(0);
      expect(problems).toEqual([]);
      const stored: any = clone(Object.fromEntries(store));
      for (const [key, value] of Object.entries(stored) as any) {
        if (value.nativeHostCwd !== undefined && capture.store[key]?.nativeHostCwd === undefined) {
          expect(value.nativeHostCwd).toBe(root + '/repo'); delete value.nativeHostCwd;
        }
        if (value.claudePermissionMode !== undefined && capture.store[key]?.claudePermissionMode === undefined) {
          expect(value.claudePermissionMode).toBe(value.permissionMode ?? 'unknown'); delete value.claudePermissionMode;
        }
      }
      expect(stored).toEqual(capture.store);
      expect(modelCalls).toBe(0);
      listFailure = false;
      return replayedChunks;
    },
    async isolation($: any, discoveryDown = false) {
      const before = calls;
      listFailure = discoveryDown;
      for (const type of [undefined, 'general-purpose', 'Explore', 'fork', 'other-plugin:codex-native', 'fugato:codex-worker']) {
        const agentId = type ? `other-${type}` : undefined;
        agents = type ? [{ id: agentId, type, status: 'running', description: 'unchanged' }] : [];
        // A stale record must not hijack a live agent of a different type.
        if (agentId) store.set(`native:v2:native-session:${agentId}`, { type: TYPE });
        if (discoveryDown && agentId) await $.classic.SubagentStart({ session_id: sessionId, agent_id: agentId, agent_type: type });
        const start = { agentId, turnId: 'other-turn', text: 'Leave this agent alone.' };
        expect(await $.turn.start(start)).toEqual({ turnId: 'other-turn' });
        const { result } = await drain($.turn.step({ agentId, turnId: 'other-turn', index: 0, model: 'haiku', messageCount: 1 }));
        expect(result.answer).toBe('unchanged model bottom');
      }
      expect(modelCalls).toBe(6);
      expect(calls).toBe(before);
      listFailure = false;
    },
    async errors($: any) {
      const initialModelCalls = modelCalls;
      processes = [clone(captures[0].processes[0])];
      agents = [{ id: 'native-agent', type: TYPE, status: 'running', description: 'failure' }];
      const dispatch = captures[0].events[1].input;
      for (const failure of ['process', 'hook', 'missing-node']) {
        store = new Map();
        if (failure === 'missing-node') sessionId = 'missing-node-session';
        // Establish the permission binding before testing unrelated failures.
        const spawn = captures[0].events.find((event: any) => event.event === 'agent.spawn').input;
        expectedPrompt = spawn.prompt;
        await $.agent.spawn(spawn);
        await $.turn.start(dispatch);
        processFailure = failure === 'process'; getFailure = failure === 'hook'; missingNode = failure === 'missing-node';
        const { result } = await drain($.turn.step(captures[0].events[2].input));
        expect(JSON.parse(result.answer).status).toBe('blocked');
        if (missingNode) expect(JSON.parse(result.answer).summary.includes('Node.js')).toBe(true);
        expect(result.usage).toBeNull();
        expect(modelCalls).toBe(initialModelCalls);
      }
    },
    async report($: any, fields: any) {
      const capture = clone(captures[3]);
      const step = capture.events.find((event: any) => event.event === 'turn.step');
      store = new Map(); agents = []; processes = capture.processes.slice(0, step.processCount);
      const task = processes.find((record: any) => record.kind === 'spawn' && record.request.argv[2] === 'task');
      const lines = task.chunks.filter((chunk: any) => chunk.stream === 'stdout').map((chunk: any) => chunk.text).join('').trimEnd().split('\n');
      const report = { ...JSON.parse(lines.pop()), ...fields };
      task.chunks = [{ stream: 'stdout', text: [...lines, JSON.stringify(report)].join('\n') + '\n' }];
      task.exit.code = report.status === 'blocked' ? 2 : 0;
      if (calls > 0 && processes[0]?.request.argv[0] === 'node') processes.shift();
      const spawn = capture.events.find((event: any) => event.event === 'agent.spawn');
      const start = capture.events.find((event: any) => event.event === 'turn.start');
      expectedPrompt = start.input.text;
      await $.agent.spawn(spawn.input);
      await $.turn.start(start.input);
      const { result } = await drain($.turn.step(step.input));
      const answer = JSON.parse(result.answer);
      expect(answer.status).toBe(report.status);
      expect(answer.blockers).toEqual(report.blockers);
      expect(processes).toHaveLength(0);
      expect(problems).toEqual([]);
      expect(modelCalls).toBe(0);
      return answer;
    },
  };
}

for (const [index, capture] of captures.entries()) {
  // Replays drive real UI mounts and recovery timers; a loaded machine needs headroom.
  test(`native replay ${index + 1}: ${capture.behavior}`, { timeoutMs: 30000 }, async ($, on) => {
    const f = fixture(on), prompts: any[] = [];
    const engine = { type: 'engine', ref: 0 };
    if (index === 0) {
      on('ui.render', { component: 'UserMessage' }, () => engine as any);
      for (const event of capture.events.filter((event: any) => event.event === 'turn.start')) {
        prompts.push(await $.ui.mount({ plugin: 'fugato', surface: 'terminal', component: 'UserMessage',
          requestId: `${event.input.agentId}:${event.input.turnId}`,
          props: { text: event.input.text, origin: { kind: 'unclassified' }, isExpanded: true } }));
      }
    }
    try {
      for (const ui of prompts) expect(await ui.drawn()).toEqual(engine);
      await f.replay($, capture);
      // A follow-up must retain the preceding turn's log under its own prompt.
      for (const ui of prompts) {
        const tree = await ui.drawn();
        expect(tree.children[0].children[0].children[0].props.bold).toBe(true);
        expect(tree.children[1]).toEqual(engine);
        expect(tree.children.length > 1).toBe(true);
      }
    } finally { for (const ui of prompts) await ui.unmount(); }
  });
}

test('other loops pass untouched; process and hook failures block without a model', async ($, on) => {
  const f = fixture(on);
  await f.isolation($);
  await f.errors($);
});

test('typed blockers preserve runtime recovery and only native reports are projected', async ($, on) => {
  const f = fixture(on), reports = new Map();
  let fallbackText = '';
  const plain = (node: any): string => typeof node === 'string' ? node
    : (node.props?.text || '') + (node.children ?? []).map(plain).join('');
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => { fallbackText = e.props.text; return { type: 'engine', ref: 0 }; });
  for (const code of ['fixture_blocker', 'context_window_exceeded', 'provider_refused', 'auth_required']) {
    reports.set(code, await f.report($, { status: 'blocked', blockers: [{ code }] }));
  }
  for (const code of ['context_window_exceeded', 'provider_refused', 'auth_required']) {
    expect(reports.get(code).next).not.toBe(reports.get('fixture_blocker').next);
    const next = 'fugato status predecessor --json';
    expect((await f.report($, { status: 'blocked', blockers: [{ code }, { code: 'thread_busy' }], next })).next).toBe(next);
  }
  const render = async (text: string) => {
    const ui = await $.ui.mount({ plugin: 'fugato', surface: 'terminal', component: 'AssistantMessage', requestId: 'report', props: { text } });
    try { const tree: any = await ui.drawn(); return tree.type === 'engine' ? fallbackText : plain(tree); }
    finally { await ui.unmount(); }
  };
  const native = captures[3].events.find((event: any) => event.event === 'turn.step').result.answer;
  expect(await render(native)).not.toBe(native);
  const legacy = JSON.stringify({ ...JSON.parse(native), details: `duet result '${JSON.parse(native).jobId}' --details` });
  expect(await render(legacy)).toBe(await render(native));
  const question = 'Choose the fixture direction?';
  expect(await render(JSON.stringify({ ...JSON.parse(native), status: 'needs_answer',
    question: { text: question, options: ['A', 'B'] } }))).toContain(question);
  for (const text of ['ordinary assistant text', JSON.stringify({ status: 'completed', summary: 'ordinary JSON' }),
    JSON.stringify({ ...JSON.parse(native), data: { kept: true } })]) {
    expect(await render(text)).toBe(text);
  }
});

test('SubagentStart identifies the first native turn while discovery rejects; other types still pass through', async ($, on) => {
  const f = fixture(on);
  await f.replay($, captures[3], true);
  await f.isolation($, true);
});

// Exercise the same engine path with adversarial stdout chunk boundaries and
// a burst beyond the notice budget, keeping the captured final C2 unchanged.
test('progress is bounded, split lines survive, duplicate notices collapse, and JSON stays final-only', async ($, on) => {
  const capture: any = clone(captures[3]);
  const step = capture.events.find((e: any) => e.event === 'turn.step');
  const reload = capture.events.find((e: any) => e.event === 'reload');
  capture.events = capture.events.slice(0, capture.events.indexOf(reload));
  capture.processes = capture.processes.slice(0, step.processCount);
  const task = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === 'task');
  const lines = Array.from({ length: 245 }, (_, i) => `burst ${i}`);
  lines.splice(0, 6, 'Codex: progress · running', 'Bash(example) · Done (1s)', 'Bash(example) · Error: exit 1 (1s)',
    '✓ exit 0 · 1.0s · legacy command', '✗ legacy failure', '? Waiting for Claude: discuss · running');
  const liveOnly = ['▸ legacy command', 'Bash(example) · running'];
  const longLine = 'y'.repeat(240);
  task.chunks.unshift(
    { stream: 'stderr', text: '[1] stderr must never be progress\n' },
    { stream: 'stdout', text: '[0' },
    { stream: 'stdout', text: '] repeat\n[1] repeat\n' + liveOnly.map(text => `[2] ${text}\n`).join('') + '[2] ' + 'x'.repeat(5000) },
    { stream: 'stdout', text: '\n[3] ' + longLine + '\n' + lines.map((text, i) => `[${i + 4}] ${text}\n`).join('') },
  );
  // After the durable cap, keep activity arriving between heartbeat ticks.
  // Neither repeated lines nor live-only command starts may starve the stream.
  task.timeline = [
    ...task.chunks.slice(0, 4).map((chunk: any) => ({ chunk })),
    ...['burst 244', ...liveOnly, 'burst 244'].flatMap(text => [
      { advance: 15000 }, { chunk: { stream: 'stdout', text: `[250] ${text}\n` } },
    ]),
    { advance: 30000 },
    ...task.chunks.slice(4).map((chunk: any) => ({ chunk })),
  ];
  const start = capture.notices[0];
  // The final usage notice is exempt from the progress cap.
  const usage = capture.notices.filter((n: any) => n.message.content[0].text.startsWith('Codex tokens (provider: OpenAI Codex,'));
  capture.notices = [start, ...['repeat', longLine.slice(0, 200), ...lines.slice(0, 197)].map(text => ({ agentId: 'native-agent',
    message: { type: 'system', content: [{ type: 'text', text }] } })), ...usage];
  step.chunks = [...capture.notices.slice(0, 200).map((notice: any) => ({ kind: 'thinking', index: 0,
    text: notice.message.content[0].text + '\n' })),
    ...Array.from({ length: 3 }, () => ({ kind: 'thinking', index: 0, text: expect.any(String) })),
    ...step.chunks.filter((chunk: any) => chunk.kind !== 'thinking')];
  const state: any = Object.values(capture.store)[0];
  state.finishedAt += 90000;
  state.notices = { turnId: 'turn-1', count: 200, last: 'burst 196', started: true };
  if (usage.length) Object.assign(state.notices, { count: 200 + usage.length, last: usage.at(-1).message.content[0].text, usage: true });
  const engine = { type: 'engine', ref: 0 };
  let spinner: any, toolRow: any, promptRow: any, endedLog: any, refusedRow: any;
  let replayedChunks: any[] = [], nativeSpinnerHostCalls = 0;
  const counts: number[] = [];
  const f = fixture(on, async notices => {
    if (counts.at(-1) === notices.count || ![1, 5, capture.notices.length].includes(notices.count)) return;
    counts.push(notices.count);
    expect((await spinner.drawn()).type).toBe('Box');
    expect(nativeSpinnerHostCalls).toBe(0);
    const tree = await promptRow.drawn();
    expect(tree.children[0].children[0].children[0].props.bold).toBe(true);
    expect(tree.children[1]).toEqual(engine);
    expect(tree.children.length > 1).toBe(true);
    expect((await toolRow.drawn()).children[0]).toEqual(engine);
    endedLog = clone(tree);
  });
  on('ui.render', { component: 'Spinner' }, () => { nativeSpinnerHostCalls++; return engine as any; });
  on('ui.render', { component: 'ToolUse' }, () => engine as any);
  on('ui.render', { component: 'UserMessage' }, () => engine as any);
  spinner = await $.ui.mount({ plugin: 'fugato', surface: 'terminal', component: 'Spinner', requestId: 'native-agent',
    props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' } });
  promptRow = await $.ui.mount({ plugin: 'fugato', surface: 'terminal', component: 'UserMessage',
    requestId: 'native-agent:turn-1', props: { text: capture.events.find((event: any) => event.event === 'turn.start').input.text,
      origin: { kind: 'unclassified' }, isExpanded: true } });
  toolRow = await $.ui.mount({ plugin: 'fugato', surface: 'terminal', component: 'ToolUse', requestId: 'spawn-1',
    props: { tool_use_id: 'spawn-1', tool: 'Agent', input: { subagent_type: TYPE },
      isRunning: false, isErrored: false, isInterrupted: false } });
  try {
    expect(await spinner.drawn()).toEqual(engine);
    nativeSpinnerHostCalls = 0;
    replayedChunks = await f.replay($, capture);
    expect(counts).toEqual([1, 5, capture.notices.length]);
    // While running the Spinner carries the status; a returned report owns the final status.
    const plainRow = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plainRow).join('');
    expect(endedLog.children.some((row: any) => /^running · /.test(plainRow(row)))).toBe(false);
    const ended = await promptRow.drawn();
    expect(ended.children).toEqual(endedLog.children);
    expect(ended.children.some((row: any) => /^done(?: · |$)/.test(plainRow(row)))).toBe(false);
    expect(f.notices().filter((notice: any) => liveOnly.includes(notice.message.content[0].text))).toHaveLength(0);
    await $.turn.start({ agentId: 'native-agent', turnId: 'refused-turn', text: 'x'.repeat(65537) });
    const refused = await drain($.turn.step({ ...step.input, turnId: 'refused-turn' }));
    expect(JSON.parse(refused.result.answer).status).toBe('blocked');
    refusedRow = await toolRow.drawn();
  } finally {
    for (const ui of [spinner, toolRow, promptRow]) await ui.unmount();
  }
  expect(capture.notices).toHaveLength(200 + usage.length);
  const thinking = replayedChunks.filter((chunk: any) => chunk.kind === 'thinking');
  expect(thinking).toHaveLength(203);
  expect(thinking.every((chunk: any) => chunk.text.trimEnd().length <= 200)).toBe(true);
  expect(step.result.answer.includes('burst')).toBe(false);
  expect(step.result.answer.includes('repeat')).toBe(false);
  const append = await faultKeepalives('append'), lookup = await faultKeepalives('lookup');
  expect({ refusedRow, append, lookup }).toEqual({ refusedRow: engine,
    append: { thinking: 24, notices: 1, finalChunks: 0, liveUpdates: 23 }, lookup: { thinking: 24, notices: 0, finalChunks: 0, liveUpdates: 23 } });
  const queue = await faultKeepalives('queue'), display = await displayReplay();
  expect({ queue, display }).toEqual({ queue: { maxHeartbeatPending: 1, heartbeatPending: 1 }, display: {
    parent: engine, unidentified: engine, decorated: [true, true, true], firstRetained: true, oldTurnsRetained: [true, true],
    phases: [['claude'], ['claude', 'claude'], ['success', 'claude'], ['success', 'success']], appendCalls: 15,
    binding: { followupLog: true, normalizedId: true, ambiguousPrefix: engine, nonCoordinator: engine, unmatchedCoordinator: engine,
      echoOrder: [engine, engine], echoRetained: [engine, engine], extraEcho: engine, bareFallback: engine, unappended: true },
    ambiguity: { ambiguous: [engine, engine], resolved: engine, consumed: engine },
    projection: { hostNodes: 1, promptAndLogKept: true, nonNative: engine, fallback: engine, renderAccess: [] }
  } });
  for (const fault of ['owner-append', 'owner-save'] as const) {
    expect(await faultKeepalives(fault)).toEqual({ injected: true, consumed: true, earlyClose: false, logged: true });
  }
});

test('compact logs retain failed and unfamiliar commands beside folded exploration', async () => {
  await displayReplay(async ({ run }: any) => {
    const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
    const entries = (tree: any) => tree.children.filter((entry: any) => entry.props?.flexDirection === 'column' && /^  [✓✗●■!]/.test(plain(entry)));
    const foldCount = (entry: any) => Number(/explored (\d+) commands/.exec(plain(entry))?.[1] ?? 0);
    const command = (text: string, result = 'Done') => `Bash(${text}) · ${result}`;
    const result = await run('compact', 'turn-1', true, [command('cat a'), command('rg --files lib'),
      command('node change.mjs', 'Error: exit 1')]);
    const log = entries(result.phases.at(-1));
    expect(log.map(foldCount)).toEqual([2, 0]);
    expect(log.at(-1).children[0].children[0].children.at(-1).props.color).toBe('error');
    // Commands the display cannot classify must remain visible individually.
    for (const [index, text] of ['cat b > output', 'find . -de"lete"', 'rg --pre=script x b'].entries()) {
      const boundary = await run(`boundary-${index}`, 'turn-1', true, ['cat a', text, 'cat c'].map(value => command(value)));
      expect(entries(boundary.phases.at(-1)).map(foldCount)).toEqual([0, 0, 0]);
    }
    const paired = await run('paired', 'turn-1', true, [command('cat a', 'running'), command('cat a', 'running'),
      command('cat a'), command('cat a'), command('rg x b', 'running'), command('rg x b', 'Error: exit 3')]);
    expect(entries(paired.phases.at(-1)).map(foldCount)).toEqual([2, 0]);
  });
});

test('each turn gives its final status to the report or to the interrupted feed, never both', async () => {
  await displayReplay(async ({ run, setColumns, setPane }: any) => {
    setPane();
    const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
    const rows = (node: any): string[] => typeof node === 'string' ? []
      : node.type === 'Box' && node.children?.[0]?.type === 'Text' ? [plain(node)] : (node.children ?? []).flatMap(rows);
    for (const status of ['completed', 'needs_answer', 'needs_input', 'blocked', 'failed', 'interrupted', 'cancelled', 'owner_stopped', 'ownership_moved']) {
      setColumns(120);
      const stopped = ['interrupted', 'cancelled', 'owner_stopped', 'ownership_moved'].includes(status);
      const word = status === 'completed' ? 'done' : status.startsWith('needs_') ? 'asks Claude'
        : ['owner_stopped', 'ownership_moved'].includes(status) ? 'interrupted' : status;
      const result = await run(`status-${status}`, 'turn-1', true,
        ['Codex: Progress stays visible.', `Codex: [${status}] Duplicate closing summary.`, 'Bash(npm test) · Done (2s)'],
        `Check ${status}.`, undefined, false, { elapsedMs: 68000, report: {
          status, worker: 'Benett', summary: `Final ${status}.`, usage: { totalTokens: 200000 },
          ...(status.startsWith('needs_') ? { question: { text: 'Which branch?', options: ['main', 'rc-int'] } } : {}) } });
      const final = `${word} · 1m 8s · /fugato-live Benett`;
      expect(rows(result.tree).filter(row => row === final)).toHaveLength(stopped ? 1 : 0);
      if (stopped) expect(rows(result.tree).slice(-2)).toEqual([' ', final]);
      expect(plain(result.tree)).not.toContain('Duplicate closing summary.');
      expect(plain(result.tree)).toContain('Progress stays visible.');
      expect(result.summaries.some((tree: any) => plain(tree).includes('  ✓ npm test · 2s'))).toBe(true);
      expect(plain(await result.spinner())).toBe('');
      expect(result.phases.every((phase: any) => !rows(phase).some(row => row.startsWith('running · ')))).toBe(true);
      if (status === 'interrupted') for (let columns = 0; columns <= 200; columns++) {
        setColumns(columns);
        expect(rows(await result.redraw()).every(row => textWidth(row) <= columns)).toBe(true);
      }
      for (const columns of [120, 60]) {
        setColumns(columns);
        const report = await result.drawReport();
        expect(rows(report).at(-1)).toBe(`${word} · 1m 8s · 200k tokens · /fugato-live Benett`);
        expect(rows(await result.redraw()).some(row => row === final)).toBe(false);
      }
      if (status === 'needs_input' || status === 'interrupted') {
        for (let columns = 0; columns <= 200; columns++) {
          setColumns(columns);
          expect([...rows(await result.drawReport()), ...rows(await result.redraw())].every(row => textWidth(row) <= columns)).toBe(true);
        }
      }
    }
  });
});
