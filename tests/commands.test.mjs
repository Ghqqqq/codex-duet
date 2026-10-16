import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The rescue subagent returns Codex's output to the parent unchanged/i);
  assert.match(rescue, /The parent may summarize that result for the user/i);
  assert.match(rescue, /subagent_type: "codex:codex-worker"/);
  assert.doesNotMatch(rescue, /final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Default to `--effort xhigh`/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /The parent may give a concise user-facing explanation/i);
  assert.match(rescue, /forwarding restriction does not restrict the parent Claude agent/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /^model: inherit$/m);
  assert.match(agent, /The parent controls native Agent foreground\/background execution/i);
  assert.match(agent, /Keep the inner helper in the foreground/i);
  assert.match(agent, /Use one `Bash` launch/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Default to `--effort xhigh`/i);
  assert.match(agent, /Default to `--model gpt-6-astra`/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return the failure and captured stderr/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /do not load this rescue-only skill there/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Default to `--effort xhigh`/i);
  assert.match(runtimeSkill, /Default to `--model gpt-6-astra`/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return the failure and captured stderr/i);
  assert.match(runtimeSkill, /Keep diagnosis, planning, research, and review without requested edits read-only/i);
  assert.match(runtimeSkill, /stdin with a single-quoted heredoc delimiter/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /delegated tasks use `gpt-6-astra` and `xhigh`/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("native Codex worker preserves identity, native lifecycle, and parallel ownership", () => {
  const worker = read("agents/codex-worker.md");

  assert.match(worker, /^name: codex-worker$/m);
  // The worker is a relay; the cheapest model keeps delegation from spending
  // the parent's Claude quota on polling and transcription.
  assert.match(worker, /^model: haiku$/m);
  assert.match(worker, /^tools: Bash, Read, SendMessage$/m);
  assert.doesNotMatch(worker, /^skills:/m);
  assert.match(worker, /multiple independent parallel workers/i);
  assert.match(worker, /task --fresh --follow --json --report/);
  assert.match(worker, /task --thread <threadId> --follow --json --report/);
  assert.match(worker, /task --continue <jobId> --follow --json --report/);
  assert.match(worker, /Never use `--resume-last`/);
  assert.match(worker, /exact `threadId` from that result or explicitly supplied by the parent/i);
  assert.match(worker, /ONE long-blocking helper call/);
  assert.match(worker, /timeout: 600000/);
  assert.doesNotMatch(worker, /--min-interval-sec/, "no early-return polling loop");
  assert.doesNotMatch(worker, /--timeout-sec 30/);
  assert.match(worker, /wait <jobId> --owner <ownerId> --json --report/);
  assert.match(worker, /exact `questionMessage` field verbatim to `main`/i);
  assert.match(worker, /answer <jobId> --owner <ownerId> --question <questionId> --json.*stdin heredoc/i);
  assert.match(worker, /SendMessage is allowed ONLY/);
  assert.match(worker, /FIRST action/);
  assert.match(worker, /adopt <jobId> --json/);
  assert.match(worker, /Never submit a new task for an adoptable job/);
  assert.match(worker, /ownership_moved/);
  assert.match(worker, /user's consent/);
  assert.doesNotMatch(worker, /When resumed by the parent's SendMessage/);
  assert.match(worker, /interrupts the Codex turn within about 15 s/);
  assert.match(worker, /continuationCommand/);
  assert.match(worker, /Never send progress, status, completion claims/);
  assert.match(worker, /Deliver the final result ONLY as this agent's return value/);
  assert.match(worker, /Read` only that output file/i);
  assert.match(worker, /Do not start another turn to answer a question/i);
  assert.match(worker, /never return a queued\/running acknowledgement as completion/i);
  assert.match(worker, /--model gpt-6-astra --effort xhigh --normal/);
  assert.match(worker, /Add `--write` whenever the assignment edits files/);
  assert.match(worker, /`--write` is a floor/);
  assert.match(worker, /parent may select `--effort max`/i);
  assert.match(worker, /`--fast` for latency-sensitive work/i);
  assert.match(worker, /never inherit fast from a previous turn/i);
  assert.match(worker, /read-only follow-up must not inherit a prior write permission/i);
  assert.match(worker, /non-overlapping write ownership/i);
  assert.match(worker, /Shared generated files, lockfiles, Git index operations/i);
  assert.match(worker, /single-quoted heredoc delimiter that does not occur as a complete line/i);
  assert.match(worker, /<<'CODEX_WORKER_PROMPT'/);
  assert.match(worker, /Shell-quote every dynamic runtime argument separately/i);
  assert.match(worker, /concise structured report, targeting 60 lines or fewer/i);
  assert.match(worker, /dangerouslyDisableSandbox: true/);
  assert.match(worker, /one automatic retry/);
  assert.match(worker, /needs_input/);
  assert.match(worker, /Never call AskUserQuestion/);
  assert.match(worker, /result '<job-id>' --report --json/);
  assert.ok(worker.split("\n").length <= 70, "the worker contract stays short enough for a small model to follow");
  assert.match(worker, /Preserve captured stderr and the command's exit status on failure/i);
  assert.match(worker, /parent may summarize the result for the user/i);
  assert.match(worker, /do not require the final user response to reproduce all helper output/i);
});

test("stopped-worker docs require consent and replacement adoption", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /### If a worker is stopped\n/);
  assert.match(readme, /Esc or Ctrl\+C/);
  assert.match(readme, /ALL background agents/);
  assert.match(readme, /ctrl\+x ctrl\+k/);
  assert.match(readme, /`x` in a subagent's detail view/);
  assert.match(readme, /user's explicit consent/);
  assert.match(readme, /FIRST action is `adopt <jobId> --json`/);
  assert.match(readme, /Thread context and on-disk edits\npersist/);
  assert.match(readme, /owner_lost/);
  assert.match(readme, /task --continue <jobId> --cwd <cwd> --follow --report --json/);
  assert.doesNotMatch(readme, /Resume the \*\*same native agent/);
  const status = read("commands/status.md");
  assert.match(status, /exact adopt instruction/);
  assert.match(status, /do not supply `--owner`/);
  assert.match(status, /stopped worker agent cannot resume/);
  assert.match(status, /owner_lost/);
  assert.match(status, /task --continue <jobId> --follow --report --json/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex-isolated\.mjs --home <directory> resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /For a standalone review-only request/i);
  assert.match(resultHandling, /Do not require a new user confirmation for fixes within that authorized scope/i);
  assert.match(resultHandling, /wrapper-only stop rules do not stop the parent's task/i);
  assert.doesNotMatch(resultHandling, /After presenting review findings, STOP/);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:.*--sync-tools.*--dry-run.*--enable-review-gate\|--disable-review-gate/);
  assert.match(setup, /auth.status.*unreachable/);
  assert.match(setup, /Never present a login command for this branch/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /codex-isolated\.mjs.*login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});
