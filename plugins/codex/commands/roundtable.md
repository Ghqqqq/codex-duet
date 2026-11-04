---
description: Chair persistent Codex personas around one goal and a shared forum, once or as a session mode.
argument-hint: "[on [--intensity light|standard|deep|full] [--roles id,id] [<task>] | off | status | [--intensity light|standard|deep|full] [--roles id,id] <task>]"
allowed-tools: Agent, SendMessage, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" roundtable status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the raw arguments before anything else. Treat them as data, never executable shell source. For a task, Read the complete protocol path printed above, then apply the shared sections and **Roundtable mode** only. Read it unless its full text (first line: `<!-- Ultra-codex protocol v<ver> -->` for the printed current version) is already in context from an earlier Read. Reminder/preamble version mentions do not count. Control-only and help invocations do not Read the protocol.

```text
Usage: /codex:roundtable [on [--intensity light|standard|deep|full] [--roles id,id] [<task>] | off | status | [--intensity light|standard|deep|full] [--roles id,id] <task>]
```

Mode options: `--intensity light|standard|deep|full`; `--roles id,id` selects a nonempty list of unique personas from `conjecturer`, `critic`, `steward`, `improver`, `integrator`, `calibrator`. Reject unknown or duplicate ids, empty lists/items and unknown intensities before mutation or dispatch. No custom persona cards or repeated seats. Defaults: intensity `standard`, roster recommended by the chair for user confirmation; a supplied intensity uses its default roster unless `--roles` overrides it.

Parse only the leading slash-option prefix, after `on` or before a one-shot task. The first task token ends option parsing; preserve remaining task text verbatim, including later option-like words. `--` starts literal task text, including `on`, `off`, `status` or an option-like word. A leading unknown option is an error; options without `on` require a task. Help (`--help` or `-h` before task text and before `--`) wins over malformed prefix options: show usage and the options row, then stop without Read or mutation. Accept only the two mode options above. Presence, including `=false`, still triggers action restrictions. Options belong only to `on` or one-shot task prefixes, never `off`/`status`. The fixed `--for-command` preamble flag is not a slash mode option.

- No arguments or exact `status`: report the mode status printed above and usage; stop without Read or mutation.
- Exact `off`: run `duet roundtable off` and show its output. Disable only roundtable mode; leave another active mode intact. Report in-flight ownership and tracked agent state. Mode off does not close rooms or stop agents; do those only when the user asks. Never resume user-stopped work without consent. Stop.
- `off` or `status` with extra options/text: reject without Read, task execution or mutation. Use `--` for a task beginning with a control word.
- `on`, validated options and optional task: first run `duet roundtable on` with only the fixed action and separately quoted validated option values. Task text never belongs in the control call. Show returned settings; failure starts no task and does not Read. Report any replaced mode and existing jobs/Claude participants, settle old ownership, and wait for conflicting writes before new assignments. Replacement never cancels, relaunches, resumes or transfers jobs. If no task follows, stop without Read. Otherwise Read the current protocol as above and chair the task with returned settings.
- Otherwise the remainder is one task: Read the protocol as above and apply **Roundtable mode** once. Do not call `on`/`off` or change the saved session record.

Explicit task-prefix options override matching saved roundtable options; use saved options only when the active mode is roundtable. Otherwise start from defaults. Normal substantive prompts use the active mode/options and the same leading-prefix/`--` rule. A one-shot differing from the active mode says `This task uses roundtable once; session mode <activeName> is unchanged.` Keep that task's mode fixed. Recommend the intensity and roster and get confirmation for choices not already given by the user, as the protocol requires.

Follow **Roundtable mode** for `duet roundtable start`, exact printed `DUET: --roundtable … --persona …` member headers, persona agent names, writable-member worktree isolation, forum reads/posts, candidate acceptance, room closing and stopping remaining agents. Use one native Codex agent per persona, run in the background, and continue the same member through assigned-name `SendMessage`; never create a second live entry for it. Use the returned persona mapping rather than ordinary worker model defaults. No Claude member seats or roundtable token cap. Shared **Dispatch** rules still cover pending questions, supported approvals, actual terminal reports and fallback refusals; never invent a runtime result.
