import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");
const fixtures = [];
const run = (command, args, options) => spawnSync(command, args, { ...options, encoding: "utf8" });
after(() => {
  for (const fixture of fixtures) fs.rmSync(fixture, { recursive: true, force: true });
});

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture() {
  const root = fs.mkdtempSync(path.join(ROOT, "plugins", "codex-live", ".bump-version-"));
  fixtures.push(root);

  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.2"
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.2",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "@openai/codex-plugin-cc",
        version: "1.0.2"
      }
    }
  });
  writeJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json"), {
    name: "codex",
    version: "1.0.2"
  });
  writeJson(path.join(root, "plugins", "codex-live", ".claude-plugin", "plugin.json"), {
    name: "codex-live",
    version: "1.0.2"
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: {
      version: "1.0.2"
    },
    plugins: [
      {
        name: "codex",
        version: "1.0.2"
      },
      {
        name: "codex-live",
        version: "1.0.2"
      }
    ]
  });

  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "codex-live", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[1].version, "1.2.3");
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.3"
  });

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /plugins\/codex-live\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /plugins\[codex-live\]\.version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});

test("bump-version detects drift in each codex-live version independently", () => {
  for (const target of ["manifest", "marketplace"]) {
    const root = makeVersionFixture();
    const file = path.join(root, target === "manifest"
      ? "plugins/codex-live/.claude-plugin/plugin.json" : ".claude-plugin/marketplace.json");
    const json = readJson(file);
    if (target === "manifest") json.version = "0.0.0";
    else json.plugins.find(plugin => plugin.name === "codex-live").version = "0.0.0";
    writeJson(file, json);
    const result = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex-live/);
  }
});

test("bump-version locates marketplace plugins by name", () => {
  const root = makeVersionFixture();
  const file = path.join(root, ".claude-plugin/marketplace.json");
  const json = readJson(file);
  json.plugins.reverse();
  json.plugins.unshift({ name: "unrelated", version: "9.0.0" });
  writeJson(file, json);
  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  const plugins = readJson(file).plugins;
  assert.equal(plugins.find(plugin => plugin.name === "unrelated").version, "9.0.0");
  for (const name of ["codex", "codex-live"]) {
    assert.equal(plugins.find(plugin => plugin.name === name).version, "1.2.3");
  }
  const check = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(check.status, 0, check.stderr);
});
