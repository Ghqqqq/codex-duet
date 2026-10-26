# Codex Live

A read-only live pane for the current Claude session's Duet Codex jobs. It shows
status, elapsed time, model/effort, assignment prompts, messages, commands, file changes, tool calls,
plans and pending questions in Claude Code’s transcript style: a bullet, bold tool
name and indented result. Messages use light inline styling for bold, code,
headings, lists and links; fenced code and tables stay on one row per source line.
Status colours follow your theme. Select a session row to view its conversation.

Each detailed turn shows its assignment prompt (up to 20,000 characters),
collapsed to three rows with click-to-expand/collapse.
Resolved `ask_parent` calls show the parent's answer (up to 2,000 characters),
matched only by call ID, never by order. On fresh and resumed threads, the parent
bridge preserves Codex's `_meta.callId` for matching. Answers without a valid
call ID, including older stored answers, are not shown.

Jobs in this Claude session that share a Codex `threadId` appear as one session,
including `duet task --to`, `--thread` and `--continue` follow-ups. Its row shows the
lifecycle owner's summary, status and elapsed time, plus a turn count when it fits.
Any active turn keeps the session active; an active turn with a pending question
takes priority. Otherwise an unresolved turn takes priority over ended turns.
Refused follow-ups that never started stay in history without replacing the
owner's status, footer or question. Selecting the session shows retained turns
in creation order; follow-ups preserve selection and following. Clear finished
never hides a session with an active or unresolved turn. A new started follow-up
reveals a cleared session's history again. Jobs without a thread ID stay separate
until one is known; saved job selections and scroll positions migrate to their session.

Install from the Duet marketplace with `/plugin install codex-live@duet`, then
use `/codex-live` to open and focus the pane at any terminal width. New active
jobs also request a pane automatically; Claude Code leaves it undrawn below
its automatic-opening width threshold. Closing it keeps it closed until a new
active job appears.

The pane pins up to three session rows above the feed: newest active sessions first,
then the selected session (even from older history), then sessions ended within the last
two minutes, ordered by newest end. Done, failed, blocked, needs-input and stopped/cancelled
jobs all use this grace period. Its end time is `completedAt`; if missing or
invalid, the poller caches the time it first observed the job ended. That fallback
time is cached and persisted with session identity so reloads preserve the grace period. Eligibility updates on poll ticks, including when
no jobs are active. At two minutes an unselected ended job moves into history;
selection, its transcript and the retained jobs are unchanged.
Unanswered questions/approvals, unresolved turns and uncleared blocked/needs-input results override this recency order with `?`/`!` markers and status-line attention while preserving selection; active rows show the pending question or current operation and quiet time after one minute.
Terminal-attention protection is bounded by `ATTENTION_SESSION_LIMIT` (40) and
the state budget below. The status line counts questions for Claude, results
needing your attention and unknown outcomes separately. The attention count
includes omitted terminal-attention sessions and reports their count and the
cap. Clear removes ended attention
and resets that count, without changing job records.
When the empty pane contains hidden finished jobs, it says: “Finished jobs are
hidden. Their records follow your Duet cleanup settings.”
New workers preserve the selected conversation and its scroll position, showing `• new` until selected; returning to a viewed conversation restores its saved scroll position.

`+N more` counts omitted sessions. Its first press expands up to ten rows: active
sessions first, the collapsed rows, then the remaining history newest first. Further
presses page through every retained session, then collapse after the final page. When
all sessions fit, `− Show fewer` collapses immediately. Very short panes put a
`+N more` control in the footer (hotkey `j`) that cycles through all sessions.
At narrow widths, header navigation can also shorten to `j`; Clear finished
shortens to `Clear` or `c`. Clear never displaces the history navigation control.
Selecting history keeps that session in the collapsed header. A rule
separates the list from the feed; with one single-turn session its identity
appears in the footer instead. Unless a discovery warning takes priority, the footer shows the selected job's status,
age and tool count (waiting jobs show who they await). Running jobs animate once
per second while the pane is open. Queued jobs say `Queued` with a stationary
ellipsis and have their own status-line count. Within a resolved turn, terminal
status or completion time wins over a stale unanswered question. An active
question says `Question for Claude`; a non-question wait still says
`Waiting for Claude`. Both `needs_input` and `blocked` say `Needs your attention`,
using the warning and error colours respectively in rows, headers and footer; the
footer appends the first blocker code when one is recorded, for example
`Needs your attention (provider_refused)`. An unanswered question disappears once
its deadline passes, even if no file changes, matching the companion.
An unresolved turn shows `Outcome unknown` with `!` attention instead of a finished
failure or stop. It mirrors the companion's unresolved-turn checks for missing
results, transport loss and an interrupt whose turn end is unconfirmed. Such a
turn stays visible until its outcome is resolved; the pane does not resolve it.
When the selected worker's name ends in `-N` and the pane has more than one body
row, a line above the footer explains: `-N: name reused after this session used every name`.
Tool counts prefer the stored `activityTotals.toolUses`; older records fall back
to counting paired retained events.

The plugin scrolls the feed itself. Wheel/arrows move by rows, page keys by the
feed window's height, and Home/End go to its start/end. Wheels over the pinned
header or footer leave the feed alone. Scrolling up stops following; the footer's
`↓ N new · Jump to bottom` button (hotkey `b` while focused) resumes it. Selecting
a previously viewed session restores its saved scroll position; a new selection
starts following. A plain hotkey button has the engine's `b: ` prefix;
the layout reserves those cells. Narrow footers shorten status before shortening
the button, down to `↓ Jump`.

Retention keeps the newest 20 sessions plus any active, unresolved or selected
sessions outside that group, and the newest 40 uncleared terminal-attention
sessions (`ATTENTION_SESSION_LIMIT`), subject to the state ceiling. A selected
older attention session can remain outside that additional protection cap.
Each session retains up to 20 turns; active and
unresolved turns, the lifecycle owner and the latest turn are always protected,
even when that exceeds the cap. Full activity is limited to 5 turns of the selected
session, reserving a slot for its active owner and filling the rest with the
newest turns. Rows still show the total turn count, and capped transcripts
start with an earlier-turns notice; older retained turns show only their headers.
Evicted markers can be rediscovered. Job records supply only their newest 500
activity events; the pane cannot retrieve events already evicted from that window.
Their cumulative totals survive eviction (legacy records seed totals from their
remaining events). At most 100 hashed pending tool identities are kept for
pairing; an evicted start can make its later completion count as another use.
Each detailed turn keeps up to 200 collapsed events and displays the
last 80 items with only its latest todo plan. Serialized events across all selected
turns share a 450,000-character budget, shortening
oldest message bodies first; the whole state has a 900,000-character ceiling.
Seen/auto-opened IDs, end-time observations and turn counts shrink with retained
jobs and sessions; clear tombstones are capped at 2,000. Poll bookkeeping also
drops entries for markers no longer present, so a failed publication can recover
on the next poll instead of growing an unpublishable lifetime history.
If needed, the pane drops the oldest finished, unselected history turns, then
ordinary finished unselected sessions before uncleared attention sessions, to
fit that ceiling. If attention must also be evicted, the newest is kept and
omissions are counted. Cleared attention has no special protection. Polling hydrates before composing a
single candidate view and reuses it for state publication; a concurrent pane
interaction triggers one extra composition from the latest view state in the same
update, preserving the interaction without delaying new jobs or status updates.
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
Malformed top-level or nested pane caches are reset to an empty view with one
repair diagnostic per invalid-cache episode, then rediscovered from disk. This
can lose pane-only selection, anchors and clear tombstones; job/marker files
are never repaired or rewritten.
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
feed window, optional name-reuse hint, footer, then a blank sentinel. The footer is at the last visible
body row; the sentinel is just beyond it. The 2.1.302 API says an exactly
fitting tree has no scroll range and arrows dispatch only while rows can scroll.
The sentinel supplies that range; the `ui.scroll` hook consumes every move
without `next`. Leading padding compensates for any retained engine offset,
keeping pinned rows aligned. Tests redraw the same mount at 20, 14, then 20 rows
on all four surfaces, docked and inline, with offsets 0, 1 and 5. They check the
footer's position, unchanged job rows, following and stopped feeds, page and
wheel scrolling, the footer's jump control and polling at the smaller height.
Very short panes reduce the job list; a one-row body shows only the footer,
and a two-row body shows the name-reuse hint when applicable, otherwise one
transcript row above the footer.

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
the valid persisted view. Directory listing and new-marker failures have a
separate discovery warning, even with no selected job or with healthy cached
jobs. The warning replaces empty-inventory copy and takes footer priority;
diagnostics are emitted on changes/recovery rather than repeated for each retry.
A fresh absent directory is quiet, but disappearance after known jobs warns.
Recovery clears the discovery warning. Commands and tool calls pair overlapping starts/completions
FIFO at the completion’s sequence position. Cancelled/declined calls say
`Cancelled`; unmatched starts in ended jobs say `Interrupted` without an age,
and individual tool starts in unresolved turns still say `Unresolved` (the
worker status says `Outcome unknown`). No logs/results/diffs are
loaded into the view. Requires Claude Code's 2.1.302 function-hooks pane API.
