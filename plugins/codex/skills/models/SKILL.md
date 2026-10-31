---
name: models
description: Check, compare or change Codex worker models and reasoning efforts in Duet. Load when the user asks to change, compare or check worker models or efforts, or when a dispatch fails on an unknown model.
---

# Codex worker models

## Tiers and modes

| Setting | Modes and stages |
| --- | --- |
| `defaultModel` (strong tier) | Ordinary delegation, pair, duel, and ultra's adversarial verification, judging and hard debugging |
| `defaultEffort` | Ordinary delegation, pair and duel |
| `ultraRoutineModel` (routine tier) | Ultra's scans, implementation and ordinary review |

Ultra keeps stage efforts: `medium` for mechanical scans, `xhigh` for implementation
and ordinary review, and `xhigh` or supported `max` for strong-tier work.
These settings are shared tiers, not per-mode preferences. For example, changing
pair's model also changes ordinary delegation, duel and ultra's strong tier.

## Discover before choosing

Run `duet models` or `duet models --json` and read the returned descriptions.
Choose the most capable available model for the strong tier and a fast workhorse
for the routine tier, respecting the user's cost and speed preferences. Never
assume current model names from memory. Use `--all` to include hidden models.
The output identifies its source (`app-server` or the isolated Codex cache), the
supported efforts, default efforts and the effective tiers with their sources.
An unknown context window is shown as `unknown` (JSON `null`); the app-server
does not currently expose that field. If neither source is available, run
`/codex:setup` to check runtime readiness and sign-in.

## Change defaults

Substitute discovered slugs and supported efforts, preview the requested change,
then apply it without `--dry-run`:

```text
duet setup --default-model <slug> --default-effort <effort> --ultra-routine-model <slug> --dry-run
duet setup --default-model <slug> --default-effort <effort> --ultra-routine-model <slug>
```

Use only the flags needed for the user's change. Pass `default` for any setting
to reset it to its built-in value. Precedence is explicit user choice > recorded
thread settings on follow-ups > saved defaults > built-ins. A saved change does
not override an existing thread's recorded settings.

Setup and hooks never start a runtime to validate efforts. They accept the static
set (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) plus efforts in any
model in Codex's cached list. The static set applies when the cache is missing.
Check that the chosen model supports the chosen effort.

## Override one dispatch

Put `DUET: --model <slug> --effort <effort>` on the first line of that native
dispatch's prompt. This overrides that dispatch only; it does not save defaults.
Follow-ups retain recorded settings unless explicitly overridden.

## Confirm

Read the effective values in the mode reminder or `duet pair status`,
`duet duel status` or `duet ultra-codex status`. `duet models` also reports both
tiers, their sources and each listed model's `inUse` markers. Confirm the result
against the user's requested tier and explain any shared-mode effect.
