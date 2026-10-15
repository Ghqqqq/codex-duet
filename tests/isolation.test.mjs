import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../plugins/codex/scripts/lib/app-server.mjs';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.mjs';
import { makeTempDir, initGitRepo, run, requireLocalSockets } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'plugins/codex/scripts/codex-companion.mjs');
function fixture() {
  const base = makeTempDir('isolated-plugin-');
  const bin = path.join(base, 'bin');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(repo);
  installFakeCodex(bin); initGitRepo(repo);
  const env = { ...buildEnv(bin), CODEX_HOME: path.join(base,'normal'), CODEX_SQLITE_HOME: path.join(base,'normal'), CODEX_COMPANION_HOME: path.join(base,"isolated user's data"), CLAUDE_PLUGIN_DATA: path.join(base,'plugin-data') };
  return {base, repo, env, state: () => JSON.parse(fs.readFileSync(path.join(bin,'fake-codex-state.json')))};
}

test('exact worker threads survive interleaved tasks and background follow-ups', async () => {
  const f = fixture();
  const task = (...args) => {
    const result = run(process.execPath, [script, 'task', '--json', ...args], { cwd: f.repo, env: f.env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = task('--fresh', '--fast', '--effort', 'max', 'Review module A');
  const second = task('--fresh', 'Review module B');
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(task('--thread', first.threadId, 'Clarify module A').threadId, first.threadId);
  assert.equal(f.state().lastTurnStart.threadId, first.threadId);
  assert.equal(f.state().lastTurnStart.serviceTier, null);
  assert.equal(f.state().lastTurnStart.effort, 'xhigh');
  assert.equal(task('--thread', second.threadId).threadId, second.threadId);
  assert.equal(f.state().lastTurnStart.threadId, second.threadId);
  task('--thread', first.threadId, '--fast', '--effort', 'max', 'Investigate the hard case');
  assert.equal(f.state().lastTurnStart.serviceTier, 'priority');
  const queued = task('--background', '--thread', first.threadId, 'Check the A edge case');
  let completed;
  for (let i = 0; i < 100; i++) {
    try {
      const files = fs.readdirSync(f.env.CLAUDE_PLUGIN_DATA, { recursive: true });
      const file = files.find(name => path.basename(name) === `${queued.jobId}.json`);
      if (file) completed = JSON.parse(fs.readFileSync(path.join(f.env.CLAUDE_PLUGIN_DATA, file)));
    } catch {}
    if (completed?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(completed?.status, 'completed');
  assert.equal(completed.result.status, 0);
  assert.equal(completed.result.threadId, first.threadId);
  assert.equal(f.state().lastTurnStart.serviceTier, null);
  assert.equal(f.state().lastTurnStart.effort, 'xhigh');
  assert.equal(f.state().lastTurnStart.model, 'gpt-6-astra');
  assert.equal(f.state().threads.length, 2, 'follow-ups must not create replacement threads');
});

test('exact thread rejects ambiguous selectors and unknown threads', () => {
  const f = fixture();
  for (const selector of ['--fresh', '--resume', '--resume-last']) {
    const result = run(process.execPath, [script, 'task', '--thread', 'thr_1', selector, 'follow up'], {cwd: f.repo, env: f.env});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be combined/);
  }
  const missing = run(process.execPath, [script, 'task', '--thread', '--json'], {cwd: f.repo, env: f.env});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /non-empty thread ID/);
  const unknown = run(process.execPath, [script, 'task', '--thread', 'missing-thread', 'follow up'], {cwd: f.repo, env: f.env});
  assert.notEqual(unknown.status, 0);
  assert.equal(f.state().threads.length, 0);
});

test('exact resume blocks only an active turn on its own thread', () => {
  const f = fixture();
  const first = run(process.execPath, [script, 'task', '--json', '--fresh', 'module A'], {cwd: f.repo, env: f.env});
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  const stateModule = new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href;
  const seedActive = (target) => {
    const result = run(process.execPath, ['--input-type=module', '-e', `import {upsertJob} from ${JSON.stringify(stateModule)}; upsertJob(process.cwd(), {id:'other-worker',jobClass:'task',status:'running',pid:${process.pid},threadId:${JSON.stringify(target)}});`], {cwd: f.repo, env: f.env});
    assert.equal(result.status, 0, result.stderr);
  };
  seedActive('unrelated-thread');
  const unrelated = run(process.execPath, [script, 'task', '--thread', threadId, 'follow up'], {cwd: f.repo, env: f.env});
  assert.equal(unrelated.status, 0, unrelated.stderr);
  seedActive(threadId);
  const blocked = run(process.execPath, [script, 'task', '--thread', threadId, 'follow up'], {cwd: f.repo, env: f.env});
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already running/);
});

for (const disableBroker of [true, false]) {
  test(`Codex child stays isolated through ${disableBroker ? 'direct' : 'broker'} transport`, async (t) => {
    if (!disableBroker && !await requireLocalSockets(t)) return;
    const f = fixture();
    const client = await CodexAppServerClient.connect(f.repo, {env:f.env, disableBroker});
    try {
      assert.equal(client.transport, disableBroker ? "direct" : "broker");
      const starts = f.state().launches;
      assert.ok(starts.length > 0);
      for (const launch of starts) {
        assert.equal(fs.realpathSync(launch.home), fs.realpathSync(f.env.CODEX_COMPANION_HOME));
        assert.equal(launch.sqlite, launch.home);
        assert.ok(launch.args.includes('cli_auth_credentials_store="file"'));
        assert.ok(launch.args.includes(`sqlite_home=${JSON.stringify(launch.home)}`));
      }
      assert.equal(fs.existsSync(f.env.CODEX_HOME), false);
    } finally { await client.close(); }
  });
}

test('rejects ordinary home and symlink aliases before spawning Codex', async () => {
  const f = fixture(); fs.mkdirSync(f.env.CODEX_HOME);
  const alias = path.join(f.base,'alias'); fs.symlinkSync(f.env.CODEX_HOME,alias);
  for (const target of [f.env.CODEX_HOME, alias, path.join(alias,'nested')]) {
    await assert.rejects(CodexAppServerClient.connect(f.repo,{disableBroker:true,env:{...f.env,CODEX_COMPANION_HOME:target}}).then(async client=>{await client.close();}), /isolat|overlap/i);
  }
});

test('refuses inherited broker without matching isolation identity', async (t) => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(); const endpoint = path.join(makeTempDir('cxi-'),'s');
  const server = net.createServer(socket => socket.on('data', data => {
    for (const line of String(data).trim().split('\n')) {
      const msg=JSON.parse(line); if(msg.id) socket.write(JSON.stringify({id:msg.id,result:{userAgent:'old-broker'}})+'\n');
    }
  }));
  await new Promise(resolve=>server.listen(endpoint,resolve));
  try { await assert.rejects(CodexAppServerClient.connect(f.repo,{env:f.env,brokerEndpoint:'unix:'+endpoint}).then(async client=>{await client.close();}), /isolat|home/i); }
  finally { await new Promise(resolve=>server.close(resolve)); }
});

test('persistent tasks support max and fast, then resume defaults back to normal', () => {
  const f=fixture();
  let result=run(process.execPath,[script,'task','--model','gpt-6-astra','--effort','max','--fast','investigate safely'],{cwd:f.repo,env:f.env});
  assert.equal(result.status,0,result.stderr);
  const state=f.state();
  assert.equal(state.lastTurnStart.effort,'max');
  assert.equal(state.lastTurnStart.serviceTier,'priority');
  assert.equal(state.threads[0].ephemeral,false);
  const status=run(process.execPath,[script,'status'],{cwd:f.repo,env:f.env});
  assert.match(status.stdout,/codex-isolated\.mjs.*--home.*resume/);
  result=run(process.execPath,[script,'task','--resume-last','continue safely'],{cwd:f.repo,env:f.env});
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.state().lastTurnStart.serviceTier,null);
  assert.equal(f.state().lastTurnStart.model,'gpt-6-astra');
  assert.equal(f.state().lastTurnStart.effort,'xhigh');
  assert.equal(f.state().lastTurnStart.threadId,state.lastTurnStart.threadId);
});

test('isolated login wrapper preserves home with spaces and inherited SQLite override', () => {
  const f=fixture();
  const capture=path.join(f.base,'capture.json');
  fs.writeFileSync(path.join(f.base,'bin','codex'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME}));\n`,{mode:0o755});
  const wrapper=path.join(root,'plugins/codex/scripts/codex-isolated.mjs');
  const result=run(process.execPath,[wrapper,'--home',f.env.CODEX_COMPANION_HOME,'login','status'],{env:f.env});
  assert.equal(result.status,0,result.stderr);
  const captured=JSON.parse(fs.readFileSync(capture));
  assert.equal(captured.home,fs.realpathSync(f.env.CODEX_COMPANION_HOME));
  assert.equal(captured.sqlite,captured.home);
  assert.ok(captured.args.includes('cli_auth_credentials_store="file"'));
});


test('background worker preserves fast mode and isolated home', async () => {
  const f=fixture();
  const result=run(process.execPath,[script,'task','--background','--fast','--effort','max','investigate safely'],{cwd:f.repo,env:f.env});
  assert.equal(result.status,0,result.stderr);
  let state;
  for (let i=0;i<100;i++) {
    try { state=f.state(); if(state.lastTurnStart) break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(state?.lastTurnStart?.serviceTier,'priority');
  assert.equal(state.lastTurnStart.effort,'max');
  for(const launch of state.launches) assert.equal(launch.home,fs.realpathSync(f.env.CODEX_COMPANION_HOME));
});


test('explicit Codex binary is honored by launch and isolated wrapper', async () => {
  const f=fixture();
  const chosen=path.join(f.base,'bin','chosen-codex');
  fs.renameSync(path.join(f.base,'bin','codex'),chosen);
  f.env.CODEX_COMPANION_BIN=chosen;
  const client=await CodexAppServerClient.connect(f.repo,{env:f.env,disableBroker:true});
  try { assert.equal(f.state().appServerStarts,1); } finally { await client.close(); }
  const wrapper=path.join(root,'plugins/codex/scripts/codex-isolated.mjs');
  const result=run(process.execPath,[wrapper,'login','status'],{env:f.env});
  assert.equal(result.status,0,result.stderr);
  const setup=run(process.execPath,[script,'setup','--json'],{cwd:f.repo,env:f.env});
  assert.equal(setup.status,0,setup.stderr);
  assert.equal(JSON.parse(setup.stdout).ready,true);
});

test('rejects inherited ordinary SQLite storage and its symlink aliases', async () => {
  const f=fixture();
  const sqlite=path.join(f.base,'ordinary-sqlite'); fs.mkdirSync(sqlite);
  const alias=path.join(f.base,'sqlite-alias'); fs.symlinkSync(sqlite,alias);
  for(const selected of [sqlite,alias,path.join(alias,'nested')]) {
    const env={...f.env,CODEX_SQLITE_HOME:sqlite,CODEX_COMPANION_HOME:selected};
    await assert.rejects(CodexAppServerClient.connect(f.repo,{env,disableBroker:true}).then(async client=>{await client.close();}),/isolat|overlap/i);
  }
});

test('changing private runtime pointer cannot reuse a broker from the previous executable', async (t) => {
  if (!await requireLocalSockets(t)) return;
  const f=fixture();
  const first=path.join(f.base,'bin','codex');
  const secondDir=path.join(f.base,'second'); fs.mkdirSync(secondDir); installFakeCodex(secondDir);
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  const runtime=path.join(f.env.CODEX_COMPANION_HOME,'runtime.json');
  fs.writeFileSync(runtime,JSON.stringify({codexBinary:first}));
  const firstClient=await CodexAppServerClient.connect(f.repo,{env:f.env}); await firstClient.close();
  assert.equal(firstClient.transport, "broker");
  fs.writeFileSync(runtime,JSON.stringify({codexBinary:path.join(secondDir,'codex')}));
  await assert.rejects(CodexAppServerClient.connect(f.repo,{env:f.env}).then(async client=>{await client.close();}),/runtime|executable|restart/i);
});
