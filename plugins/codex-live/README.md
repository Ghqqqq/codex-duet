# Codex Live

A read-only live pane for the current Claude session's Duet Codex jobs. It shows
status, elapsed time, model/effort, messages, commands, file changes, tool calls,
plans and pending questions in Claude Code’s transcript style: a bullet, bold tool
name and indented result. Messages use light inline styling for bold, code,
headings, lists and links; fenced code and tables stay on one row per source line.
Status colours follow your theme. Select a job row to view it when the session
has multiple jobs.

Install from the Duet marketplace with `/plugin install codex-live@duet`, then
use `/codex-live` to open and focus the pane at any terminal width. New active
jobs also request a pane automatically; Claude Code leaves it undrawn below
its automatic-opening width threshold. Closing it keeps it closed until a new
active job appears.

The pane pins up to three job rows above the feed: newest active jobs first,
then the selected job (even from older history), then jobs ended within the last
two minutes, ordered by newest end. Done, failed, blocked, needs-input and stopped/cancelled
jobs all use this grace period. Its end time is `completedAt`; if missing or
invalid, the poller caches the time it first observed the job ended. That fallback
time is cached and persisted with session identity so reloads preserve the grace period. Eligibility updates on poll ticks, including when
no jobs are active. At two minutes an unselected ended job moves into history;
selection, its transcript and the retained jobs are unchanged.

`+N more` counts omitted jobs. Its first press expands up to ten rows: active
jobs first, the collapsed rows, then the remaining history newest first. Further
presses page through every retained job, then collapse after the final page. When
all jobs fit, `− Show fewer` collapses immediately. Very short panes put a
`+N more` control in the footer (hotkey `j`) that cycles through all jobs. Selecting history keeps that job in the collapsed header. A rule
separates the list from the feed; with one job its identity
appears in the footer instead. The footer always shows the selected job's status,
age and tool count (waiting jobs show who they await). Running jobs animate once
per second while the pane is open. Queued jobs say `Queued` with a stationary
ellipsis and have their own status-line count. A terminal status or completion
time wins over an unanswered question; needs-input jobs show `Needs input`.

The plugin scrolls the feed itself. Wheel/arrows move by rows, page keys by the
feed window's height, and Home/End go to its start/end. Wheels over the pinned
header or footer leave the feed alone. Scrolling up stops following; the footer's
`↓ N new · Jump to bottom` button (hotkey `b` while focused) resumes it. Selecting
a job also resumes following. A plain hotkey button has the engine's `b: ` prefix;
the layout reserves those cells. Narrow footers shorten status before shortening
the button, down to `↓ Jump`.

Retention keeps the newest 20 jobs plus any active or selected jobs outside
that group. Evicted markers can be rediscovered. Only the selected job has a
transcript in view state; other jobs keep header summaries. The selected view
keeps up to 200 collapsed events and displays the last 80 items with only the
latest todo plan. Serialized events have a 450,000-character budget, shortening
oldest message bodies first; the whole state has a 900,000-character ceiling.
Full parsed job data stays in the private poll cache for selection. A rejected
state update shows `Pane update failed · <reason>` in the pinned footer until a
successful write and logs the failure at debug level.

Stopped windows use item/character anchors and content snapshots, so retention,
plan replacement and width changes clamp safely. New-row counts use content
identity; elapsed-time text and different wrapping do not add unseen content.
Surface measurements are separate and anchors work across surfaces. Rendering
normalizes immediately without writing state; the next scroll or poll persists
the clamp. Reaching the bottom resumes following. Session identity, selection,
anchors, expansion, seen/auto-opened jobs and fallback end times survive reloads.
Emoji widths and cuts use whole grapheme clusters (code points as fallback when
`Intl.Segmenter` is unavailable). The drawing reserves
64,000 characters for visible feed text and the rest of the 100,000-character
allowance for pinned rows and controls.

Each render budgets only its current `scroll.bodyRows`, never a previously
cached larger height. Render, scroll and polling share the same row allocation;
scroll uses its event's current height, and polling uses the latest measurement
for that surface. The pane and transcript allow flex shrinking with a zero
minimum height; the pinned rows do not shrink, and overflow in the transcript
is clipped. With smaller render metrics, the feed loses rows before the job list
is reduced. Growing the body restores the feed while preserving its content
anchor or following the bottom.

The requested tree height is `scroll.offset + scroll.bodyRows + 1`. After
`scroll.offset` blank rows, it contains: job header,
feed window, footer, then a blank sentinel. The footer is at the last visible
body row; the sentinel is just beyond it. The 2.1.302 API says an exactly
fitting tree has no scroll range and arrows dispatch only while rows can scroll.
The sentinel supplies that range; the `ui.scroll` hook consumes every move
without `next`. Leading padding compensates for any retained engine offset,
keeping pinned rows aligned. Tests redraw the same mount at 20, 14, then 20 rows
on all four surfaces, docked and inline, with offsets 0, 1 and 5. They check the
footer's position, unchanged job rows, following and stopped feeds, page and
wheel scrolling, the footer's jump control and polling at the smaller height.
Very short panes reduce the job list; a one-row body shows only the footer,
and a two-row body shows one transcript row above the footer.

Known limitation: while Claude Code's slash-command suggestions are open, they cover
the lower rows of a docked pane, including its footer, until the menu closes. The
engine does not redraw a pane for a height-only change and exposes no count of the
rows actually showing (`reference.md` 140–142; `RenderPropsOf.Pane.scroll` in
`types/claude-code.d.ts` 10759–10767 describes the room, not the visible rows), so
the pane cannot move its footer out of the way.

The test kit's `MountedMembers`
(16300–16304; `redraw` at 16430–16442) checks descriptions and hooks, not terminal
paint, so the tests cannot establish the engine's physical overlay behavior.

The plugin reads session markers and job JSON written by the Duet companion in
`CODEX_COMPANION_HOME` (default `~/.claude/codex-isolated`). It never writes job
files, calls the companion, answers questions, starts/cancels jobs, invokes a
model or appends session messages. Polling and rendering cost no model tokens.
The explicit slash command returns only the required `Codex pane opened.`
acknowledgement. The pane uses only Box, Text and Button on terminal, desktop, VS Code and mobile.

Polling runs every second, or every five seconds with no active jobs and no open
pane. Immutable markers are read once; job JSON is read only after its mtime
changes. Finished jobs are stat-checked every ten seconds for recovery rewrites.
Failed marker/job reads retry after five seconds, without consuming the marker
or mtime. A failed read keeps the last good view and a pinned
`⚠ stale · last update <age> ago` warning. Reload-time marker failures also keep
the persisted view. Commands and tool calls pair overlapping starts/completions
FIFO at the completion’s sequence position. Cancelled/declined calls say
`Cancelled`; unmatched starts in ended jobs say `Interrupted` without an age. No logs/results/diffs are
loaded into the view. Requires Claude Code's 2.1.302 function-hooks pane API.
