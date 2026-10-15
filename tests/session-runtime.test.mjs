import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getSessionRuntimeStatus } from "../plugins/codex/scripts/lib/codex.mjs";

test("empty runtime endpoint falls back to saved workspace broker without needing sockets", () => {
  const repo = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  saveBrokerSession(repo, { endpoint: "unix:/fixture/saved.sock" });
  for (const endpoint of [undefined, "", "  "]) {
    const env = { CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
    assert.equal(getSessionRuntimeStatus(env, repo).endpoint, "unix:/fixture/saved.sock");
    assert.equal(getSessionRuntimeStatus(env, repo).mode, "shared");
  }
  assert.equal(getSessionRuntimeStatus({ CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/fixture/override.sock" }, repo).endpoint, "unix:/fixture/override.sock");
  const result = run(process.execPath, [new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname, "status"], { cwd: repo, env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
  assert.equal(getSessionRuntimeStatus({ CODEX_COMPANION_APP_SERVER_ENDPOINT: "" }, makeTempDir()).mode, "direct");
});
