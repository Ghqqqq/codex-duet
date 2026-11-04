# Upgrade from Duet to Fugato

Fugato 1.6.0 is the new name for Duet. The marketplace and plugin install IDs
change; your Codex home and existing state stay in place.

Back to the [README](../README.md).

## Before switching

Wait for running jobs to finish, or cancel them and confirm they have stopped.
Check `duet status --all` in each workspace with jobs, including other Claude
sessions. Use `duet cancel <jobId>` in the owning session for each job you intend
to stop. `duet cancel --all` covers only the current session in that workspace.
Do not run old and new plugin versions against shared state at the same time.

Keep the same `CODEX_COMPANION_HOME` if you set one. There is no need to move or
copy `~/.claude/codex-isolated` or sign in again just for the rename.

## Switch the marketplace

Run these commands in Claude Code, using the same installation scope as the
existing plugins. Skip the `codex-live` uninstall and install lines if you do
not use the live pane:

```text
/plugin uninstall codex@duet
/plugin uninstall codex-live@duet
/plugin marketplace remove duet
/plugin marketplace add Ghqqqq/fugato
/plugin install codex@fugato
/plugin install codex-live@fugato
/reload-plugins
/codex:setup
```

Uninstall the old plugins before installing the new IDs so only one set of
hooks and adapters is active. The old `Ghqqqq/codex-duet` repository URL
redirects to `Ghqqqq/fugato`, but the plugin IDs are new: that redirect does
not rename the installed marketplace or keep `codex@duet` current.

## What stays

- The separate Codex home, `~/.claude/codex-isolated`, and its existing sign-in.
- Jobs, reports, Codex threads, run journals, roundtable rooms and saved
  settings, including model choices and browser or desktop approvals.
- The `duet/` state directory within that home, including `duet/config.toml`,
  `duet/state/`, `duet/sessions/` and `duet/roundtables/`. Keep these paths as they
  are; the rename does not migrate them.
- The plugin names `codex` and `codex-live`, all `/codex:*` slash commands,
  agent types such as `codex:codex-native`, and skill names.
- The `DUET:` native dispatch header, `DUET_*` heredoc delimiters,
  `CODEX_COMPANION_*` environment variables, the `duet_parent` MCP server and
  the `.duet-lock` file name.
- Ultra, Pair, Duel and Roundtable mode names and their controls.

## What changes

Use `fugato` for companion commands, such as `fugato task`,
`fugato result '<jobId>' --details` and `fugato setup`. The `duet` CLI remains a
working compatibility alias to the same implementation and state; existing
scripts do not select a second runtime or state store.

The marketplace is `fugato`, and the install IDs are `codex@fugato` and
`codex-live@fugato`. The repository is `Ghqqqq/fugato`; the npm package metadata
is named `fugato`.

After setup, check `/codex:status` and retrieve an existing job with
`fugato result '<jobId>' --details`. See [commands](commands.md) for current
examples and [state and retention](state-and-retention.md) for the stored layout.
