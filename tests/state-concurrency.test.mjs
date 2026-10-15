import "./test-environment.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  saveState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const workersByWorkspace = new Map();

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-concurrency-"));
  const workers = [];
  workersByWorkspace.set(cwd, workers);
  t.after(async () => {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(workers.map(run => run.done));
    fs.rmSync(resolveStateDir(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    workersByWorkspace.delete(cwd);
  });
  return cwd;
}

function worker(t, cwd, source) {
  const script = `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    import * as state from ${JSON.stringify(stateModule)};
    const cwd = ${JSON.stringify(cwd)};
    const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const ready = () => new Promise(resolve => {
      process.once("message", resolve);
      process.send("ready");
    });
    ${source}
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Worker exited before ready (${code}): ${stderr}`)));
  });
  // Some workers do not need a start barrier.
  void ready.catch(() => {});
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  const run = { child, ready, done };
  workersByWorkspace.get(cwd).push(run);
  return run;
}

async function expectSuccess(run) {
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
}

test("concurrent processes retain every job, progress update, and artifact", { timeout: 20000 }, async t => {
  const cwd = fixture(t);
  const runs = Array.from({ length: 8 }, (_, index) => worker(t, cwd, `
    await ready();
    for (let iteration = 0; iteration < 4; iteration++) {
      const id = "worker-${index}-" + iteration;
      const logFile = state.resolveJobLogFile(cwd, id);
      fs.writeFileSync(logFile, id);
      state.writeJobFile(cwd, id, { id, result: "retained" });
      state.updateState(cwd, current => {
        const count = current.config.completedUpdates || 0;
        pause(8);
        current.config.completedUpdates = count + 1;
        current.jobs.push({ id, status: "running", logFile });
      });
      state.upsertJob(cwd, { id, status: "completed", summary: "done" });
    }
  `));
  await Promise.all(runs.map(run => run.ready));
  for (const run of runs) run.child.send("go");
  await Promise.all(runs.map(expectSuccess));
  const result = loadState(cwd);
  assert.equal(result.config.completedUpdates, 32);
  assert.equal(result.jobs.length, 32);
  for (const job of result.jobs) {
    assert.equal(job.status, "completed");
    assert.equal(job.summary, "done");
    assert.equal(fs.readFileSync(job.logFile, "utf8"), job.id);
    assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(cwd, job.id), "utf8")).result, "retained");
  }
});

test("saving a stale snapshot removes only its intended jobs and preserves later work", { timeout: 10000 }, async t => {
  const cwd = fixture(t);
  upsertJob(cwd, { id: "remove", status: "completed" });
  upsertJob(cwd, { id: "keep", status: "running", phase: "starting" });
  const staleWriter = worker(t, cwd, `
    const snapshot = state.loadState(cwd);
    await ready();
    state.saveState(cwd, {
      ...snapshot,
      config: { ...snapshot.config, stopReviewGate: true },
      jobs: snapshot.jobs.filter(job => job.id !== "remove")
    });
  `);
  await staleWriter.ready;
  upsertJob(cwd, { id: "keep", status: "completed", phase: "done" });
  const logFile = resolveJobLogFile(cwd, "new");
  fs.writeFileSync(logFile, "new worker log");
  writeJobFile(cwd, "new", { result: "new worker result" });
  upsertJob(cwd, { id: "new", status: "running", logFile });
  staleWriter.child.send("go");
  await expectSuccess(staleWriter);
  const result = loadState(cwd);
  assert.deepEqual(new Set(result.jobs.map(job => job.id)), new Set(["keep", "new"]));
  assert.equal(result.jobs.find(job => job.id === "keep").phase, "done");
  assert.equal(result.config.stopReviewGate, true);
  assert.equal(fs.readFileSync(logFile, "utf8"), "new worker log");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(cwd, "new"), "utf8")).result, "new worker result");
});

test("history pruning retains every active job plus the latest 50 finished jobs", t => {
  const cwd = fixture(t);
  const logFile = resolveJobLogFile(cwd, "active-0");
  fs.writeFileSync(logFile, "still running");
  writeJobFile(cwd, "active-0", { status: "running" });
  const active = Array.from({ length: 62 }, (_, index) => ({
    id: `active-${index}`,
    status: index < 60 ? "running" : "queued",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...(index === 0 ? { logFile } : {})
  }));
  saveState(cwd, { jobs: active });
  assert.equal(loadState(cwd).jobs.length, 62);
  const history = Array.from({ length: 55 }, (_, index) => ({
    id: `finished-${index}`,
    status: "completed",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  saveState(cwd, { jobs: [...active, ...history] });
  const result = loadState(cwd);
  assert.equal(result.jobs.length, 112);
  assert.deepEqual(new Set(result.jobs.filter(job => job.id.startsWith("active-")).map(job => job.id)), new Set(active.map(job => job.id)));
  assert.deepEqual(result.jobs.filter(job => job.status === "completed").map(job => job.id),
    Array.from({ length: 50 }, (_, index) => `finished-${54 - index}`));
  assert.equal(fs.readFileSync(logFile, "utf8"), "still running");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(cwd, "active-0"), "utf8")).status, "running");
});

test("a throwing mutation releases the lock without publishing partial changes", { timeout: 10000 }, async t => {
  const cwd = fixture(t);
  const failed = worker(t, cwd, `
    assert.throws(() => state.updateState(cwd, current => {
      current.jobs.push({ id: "partial" });
      throw new Error("mutation failed");
    }), /mutation failed/);
    await ready();
  `);
  await failed.ready;
  await expectSuccess(worker(t, cwd, `state.upsertJob(cwd, { id: "after-failure" });`));
  failed.child.send("finish");
  await expectSuccess(failed);
  assert.deepEqual(loadState(cwd).jobs.map(job => job.id), ["after-failure"]);
});

test("a killed lock owner cannot block the next process or publish partial changes", { timeout: 10000 }, async t => {
  const cwd = fixture(t);
  upsertJob(cwd, { id: "before-kill" });
  const killed = worker(t, cwd, `
    state.updateState(cwd, current => {
      current.jobs.push({ id: "partial" });
      process.send("ready");
      pause(30000);
    });
  `);
  await killed.ready;
  killed.child.kill("SIGKILL");
  await killed.done;
  await expectSuccess(worker(t, cwd, `state.upsertJob(cwd, { id: "after-kill" });`));
  assert.deepEqual(new Set(loadState(cwd).jobs.map(job => job.id)), new Set(["before-kill", "after-kill"]));
});

test("concurrent readers see complete JSON while job results are replaced", { timeout: 15000 }, async t => {
  const cwd = fixture(t);
  writeJobFile(cwd, "result", { sequence: 0, payload: "x".repeat(256 * 1024) });
  const writer = worker(t, cwd, `
    await ready();
    for (let sequence = 1; sequence <= 80; sequence++) {
      state.writeJobFile(cwd, "result", { sequence, payload: "x".repeat(256 * 1024) });
    }
  `);
  const reader = worker(t, cwd, `
    const jobFile = state.resolveJobFile(cwd, "result");
    await ready();
    for (let iteration = 0; iteration < 240; iteration++) {
      const result = state.readJobFile(jobFile);
      assert.equal(result.payload.length, 256 * 1024);
      assert.ok(Number.isInteger(result.sequence));
    }
  `);
  await Promise.all([writer.ready, reader.ready]);
  writer.child.send("go");
  reader.child.send("go");
  await Promise.all([expectSuccess(writer), expectSuccess(reader)]);
});

test("unlocked state readers always see a complete published snapshot", { timeout: 15000 }, async t => {
  const cwd = fixture(t);
  saveState(cwd, { config: { sentinel: "always present", sequence: 0 }, jobs: [] });
  const writer = worker(t, cwd, `
    await ready();
    for (let sequence = 1; sequence <= 40; sequence++) {
      state.updateState(cwd, current => {
        current.config.sequence = sequence;
        current.config.payload = "x".repeat(256 * 1024);
      });
    }
  `);
  const reader = worker(t, cwd, `
    await ready();
    for (let iteration = 0; iteration < 100; iteration++) {
      const current = state.loadState(cwd);
      assert.equal(current.config.sentinel, "always present");
      assert.ok(Number.isInteger(current.config.sequence));
    }
  `);
  await Promise.all([writer.ready, reader.ready]);
  writer.child.send("go");
  reader.child.send("go");
  await Promise.all([expectSuccess(writer), expectSuccess(reader)]);
  assert.equal(loadState(cwd).config.sequence, 40);
});
