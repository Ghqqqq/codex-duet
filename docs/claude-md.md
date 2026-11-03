# Optional CLAUDE.md policy

Duet works without a personal CLAUDE.md. SessionStart supplies native dispatch
guidance, a pointer to the `codex:native-fallback` skill, and generic rules for
explicit dispatch settings, job ownership, briefs and evidence-based acceptance.
Active orchestration modes supply their own reminders and protocols. The optional
policy below adds proactive delegation outside a mode and a stated model policy.

Paste it into `~/.claude/CLAUDE.md` for all projects, or a project's `CLAUDE.md`.
Duet forwards loaded CLAUDE.md files to Codex as developer instructions; see
[instruction forwarding](direct-mode.md#context-instructions-and-explicit-forks).
The snippet costs context in every session where that file is loaded.

## Delivery to workers

When every project `CLAUDE.md` on the path from the worker's cwd through its
ancestors was forwarded with Duet's executor framing, Codex's fallback list
is Duet's default `["CLAUDE.md"]`, and no `.codex/config.toml` on that path sets
`project_doc_fallback_filenames`, the worker thread disables that fallback.
The project instructions then arrive once through `developerInstructions`;
the isolated home's config file is not changed. On runtimes that reject
per-thread config, the compatibility retry drops the override, so Codex's own
CLAUDE.md fallback stays on and project instructions can arrive twice.
`AGENTS.md` discovery remains.
Custom fallback lists, `--no-claude-md`, or incomplete project-file forwarding
keep Codex discovery enabled. See
[instruction forwarding](direct-mode.md#context-instructions-and-explicit-forks).

## Optional policy

For orchestration in every fresh session without a CLAUDE.md, use
`duet setup --default-mode pair` (or `ultra` / `duel`). See
[Default orchestration mode](configuration.md#default-orchestration-mode).

```markdown
## Codex-Claude collaboration

- Explicit user instructions and active ultra, pair or duel reminders and
  protocols take precedence over this policy.
- Outside an orchestration mode, use Duet naturally for substantive tasks that
  benefit from independent investigation, implementation or review. Handle simple
  questions and small direct edits without delegation. A delegated Codex worker
  executes its own assignment without recursively orchestrating more workers.
- Own planning, decomposition, coordination, integration and final acceptance.
  Define the intended outcome, dependencies and numbered acceptance criteria
  before dispatch. Give each worker a brief with the objective, owned paths,
  acceptance criteria and verification commands.
- Honor the dispatch route in SessionStart guidance; use native dispatch from
  the first task when that route selects it:
  `Agent(subagent_type: "codex:codex-native", description: "<purpose>", prompt: "DUET: --model <model> --effort <effort> --normal [--sandbox <mode>] [--cwd <dir>]\n<brief>")`.
  A valid, free caller `name` is kept; otherwise Duet assigns a scientist pool
  name. Use the returned name for SendMessage steering, follow-ups and answers.
  Wait for the actual result; never poll or treat a launch
  receipt or a `running` payload as completed work.
- If native dispatch returns `native_adapter_unavailable` or `native_capacity`,
  needs a per-call option the `DUET:` line rejects, or a Bash-launched worker needs
  a follow-up, load the `codex:native-fallback` skill and follow it.
- Give each independent job a fresh native agent; never run two jobs on one
  thread at once. Concurrent edits require disjoint owned paths. Serialize edits
  to shared files, indexes and generated outputs, or use separate worktrees.
- Outside an orchestration mode, use the configured worker model
  (default `gpt-6-astra`): `medium` for mechanical scans, the configured worker
  effort (default `xhigh`) otherwise, and `max` only for the hardest verification,
  judging or debugging after checking integration and runtime support. If `max` is
  unsupported, report the limitation and use `xhigh`. In a mode, follow its model
  tiers. Pass model, effort and speed explicitly in the `DUET:` line. Use
  `--normal` unless the user requests `--fast`; preserve explicit user choices.
  Add `--sandbox read-only` for investigation and review.
- Read each worker's actual diff and evidence against the acceptance criteria,
  rerun checks, run integration checks and request corrections when needed. A
  success message alone is not completion. Never simulate a notification, tool
  result or worker report.
- Present one coherent answer with the outcome, verification and limitations.
  Keep internal IDs and protocol output out unless needed to explain a failure
  or requested by the user.
```

Explicit user instructions and active mode protocols take precedence. Instead
of maintaining the snippet's model lines, take the model and effort from
`duet setup --default-model <model> --default-effort <effort>`;
`--ultra-routine-model <model>` sets ultra's routine tier. SessionStart guidance,
mode reminders and status show the effective values. See
[Default worker models](configuration.md#default-worker-models).
