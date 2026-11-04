import { atom, read } from 'claude-code';
import type { Register, Timer } from 'claude-code';
import type { CodexLiveState } from '../types';
import { feedLines, feedWindow, fit, footerLayout, paneLayout, tableRow, listTitle, emptyLines, sessionFooter,
  scrollFeed, selectedJob, toggleForumPosts, togglePrompt, width } from './layout';
import type { FeedLines, Span } from './layout';
import { clearFinished, jobLifecycle, normalizeSessions, visibleForums, visibleSessions } from './model';
import { createPoller } from './poll';
import { forumId, forumOrder, isolatedHome, readForumRoom, selectedForum } from './forum';
import { checkedView, nativeActivity, updateFailure, viewports, writeView } from './runtime';

const view = atom({ plugin: 'fugato-live', key: 'view' } as const,
  { jobs: [], selectedId: null, nowMs: 0 } as CodexLiveState);
import { limitChars } from './text';

export const register: Register = on => {
  let timer: Timer | undefined;
  // ui.scroll has rows but no columns. Keep measurements per surface;
  // content anchors survive different wrapping without render-time state writes.
  let poll: ReturnType<typeof createPoller> | undefined;
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fugato-live', description: 'Open the read-only Fugato jobs and forum pane' });
    if (!timer) { poll = createPoller($); timer = $.clock.every(1000, () => poll!()); }
    return next(e);
  });

  on('command.run', { command: 'fugato-live' }, async ($, e) => {
    if (!['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return { text: 'Open Codex activity by running /fugato-live yourself.' };
    const target = e.args.trim();
    if (/^forum(?:\s|$)/.test(target)) {
      await poll?.(true);
      const session = await $.session.id();
      const id = target.slice(5).trim();
      const state = checkedView($, await read($, view));
      const room = id ? await readForumRoom($, await isolatedHome($), session, id)
        : visibleForums(state).filter(room => room.sessionId === session).sort(forumOrder)[0];
      if (!room) return { text: id ? `Roundtable ${limitChars(id, 128)} was not found in this Claude session.`
        : 'No roundtables in this Claude session yet.' };
      const selectedId = forumId(room);
      if (!await writeView($, latest => ({ ...latest, selectedId,
        forumRooms: [...visibleForums(latest).filter(old => old.roomId !== room.roomId).sort(forumOrder).slice(0, 3),
          { ...room, viewedPosts: room.postCount }],
        feeds: { ...latest.feeds, [selectedId]: latest.feeds?.[selectedId] ?? { feedOffset: 0, following: true, seenLines: 0 } } }))) {
        return { text: 'Roundtable could not be selected.' };
      }
    } else if (target) {
      const activity = await nativeActivity($, target).catch(() => undefined);
      if (!activity) return { text: `No unique Codex activity found for ${limitChars(target, 100)}.` };
      const selectedId = activity.threadId ? `thread:${activity.threadId}` : activity.jobId;
      if (!await writeView($, latest => ({ ...latest, selectedId, openedJobId: activity.jobId,
        feeds: { ...latest.feeds, [selectedId]: { feedOffset: 0, following: true, seenLines: 0 } } }))) {
        return { text: 'Codex activity could not be selected.' };
      }
    }
    await $.ui.open({ id: 'fugato-live', title: 'Fugato', focus: true });
    await poll?.(true);
    return { text: 'Fugato pane opened.' };
  });

  on('ui.scroll', { component: 'Pane', requestId: 'fugato-live' }, async ($, e) => {
    const surface = await $.session.surface().catch(() => null);
    const measured = viewports.get(surface ?? 'terminal') ?? viewports.values().next().value;
    const columns = measured?.columns ?? 0;
    if (!columns || !e.by) return {};
    await writeView($, state => {
      state = normalizeSessions(state);
      const job = selectedForum(state) ?? selectedJob(state);
      if (!job) return state;
      const { bodyRows, pinnedRows, footerRows, rows } = paneLayout(state, job, e.bodyRows, false, columns);
      const id = 'roomId' in job ? forumId(job) : job.id;
      // A wheel over pinned chrome does not move the transcript beneath it.
      if (e.pointer && (e.pointer.row < pinnedRows || e.pointer.row >= bodyRows - footerRows ||
          e.pointer.column < 0 || e.pointer.column >= columns)) return state;
      const lines = feedLines(job, state.nowMs, columns, state.feeds?.[id]);
      const next = scrollFeed(lines, rows, state.feeds?.[id], e.by, bodyRows, e.contentRows, !!e.pointer);
      return { ...state, feeds: { ...state.feeds, [id]: { ...next, columns, surface: surface ?? 'terminal' } } };
    });
    // Consume the move; render compensates for any retained engine offset.
    return {};
  }).catch(() => ({ deny: 'Fugato feed kept its window' }));

  on('ui.render', { component: 'Pane', requestId: 'fugato-live' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const state = normalizeSessions(checkedView($, await read($, view)));
    const columns = Math.max(0, Math.floor(e.props.bodyColumns));
    const failure = updateFailure();
    const selected = selectedForum(state) ?? selectedJob(state);
    const selectedId = selected && ('roomId' in selected ? forumId(selected) : selected.id);
    const { bodyRows, header, top, nameHint, rows } = paneLayout(state, selected, e.props.scroll.bodyRows, !!failure || !!state.discoveryWarning, columns);
    viewports.set(e.surface, { columns, bodyRows });
    const engineOffset = Math.max(0, Math.floor(e.props.scroll.offset));
    const jobs = visibleSessions(state);
    const lines: FeedLines = selected ? feedLines(selected, state.nowMs, columns, state.feeds?.[selectedId!])
      : emptyLines(columns);
    const window = selected ? feedWindow(lines, rows, state.feeds?.[selectedId!]) : { lines: lines.slice(0, rows), following: true, newLines: 0 };
    const hiddenForums = visibleForums(state).sort(forumOrder)
      .filter(room => !header.forumRooms.some(shown => shown.roomId === room.roomId)).map(forumId);
    const compactIds = [...jobs.map(job => job.id), ...hiddenForums];
    const needsHistory = !!header.toggle || !header.workerRows && compactIds.some(id => id !== selectedId);
    // Preserve normal labels when they fit; compact keyboard controls remain
    // registered even when an explicitly opened pane clips their final cells.
    const clearRoom = columns - (needsHistory ? 5 : 0);
    const clearText = clearRoom >= 14 ? 'Clear finished' : clearRoom >= 5 ? 'Clear' : '';
    const clearHotkey = clearText ? undefined : 'c';
    const clearWidth = width(clearText) + (clearHotkey ? 3 : 0);
    const canClear = jobs.some(job => jobLifecycle(job).finished) || visibleForums(state).some(room => room.status === 'closed');
    const tinyClear = !header.clear && canClear;
    const tinyHistory = !!selected && !header.workerRows && compactIds.some(id => id !== selectedId);
    const historyText = fit(`+${compactIds.filter(id => id !== selectedId).length} more`, Math.max(0, columns - 3 - (tinyClear ? clearWidth + 2 : 0)));
    const footerColumns = Math.max(0, columns - (tinyHistory ? width(historyText) + 4 : 0)
      - (tinyClear ? clearWidth + 2 : 0));
    const fullToggleText = header.more ? `+${header.more} more` : '− Show fewer';
    const headerClear = !!header.clear && canClear;
    const toggleRoom = columns - (headerClear ? clearWidth + 2 : 0);
    const compactToggle = width(fullToggleText) > toggleRoom;
    const toggleText = compactToggle ? '' : fullToggleText;
    const headerToggle = header.toggle;
    const clear = async () => {
      const now = await $.clock.now();
      await writeView($, latest => clearFinished(latest, now));
      await poll?.(true);
    };
    const footer = failure ? { left: fit(`Pane update failed · ${failure}`, footerColumns), right: '', jump: '', gap: '', color: 'error' as const }
      : state.discoveryWarning ? { left: fit(state.discoveryWarning, footerColumns), right: '', jump: '', gap: '', color: 'warning' as const }
      : selected ? footerLayout(selected, state, footerColumns, window.following, window.newLines) : sessionFooter(state, footerColumns);
    const jumpToBottom = async () => {
      await writeView($, latest => ({ ...latest, feeds: { ...latest.feeds,
        [selectedId!]: { ...latest.feeds?.[selectedId!], feedOffset: 0, following: true, seenLines: 0,
          anchor: undefined, seenItems: undefined } } }));
    };
    const toggle = async (turnId: string) => {
      await writeView($, latest => {
        latest = normalizeSessions(latest);
        const job = selectedForum(latest) ?? selectedJob(latest);
        if (!job || latest.selectedId !== selectedId || ('roomId' in job
          ? !job.posts?.some(post => `post:${post.seq}` === turnId)
          : !job.turns.some(turn => turn.id === turnId && turn.prompt !== undefined))) return latest;
        const currentRows = paneLayout(latest, job, bodyRows, false, columns).rows;
        return { ...latest, feeds: { ...latest.feeds, [selectedId!]: {
          ...togglePrompt(job, latest.nowMs, columns, currentRows, latest.feeds?.[selectedId!], turnId), surface: e.surface,
        } } };
      });
    };
    const toggleAll = async () => {
      await writeView($, latest => {
        const room = selectedForum(latest);
        if (!room || latest.selectedId !== selectedId) return latest;
        const currentRows = paneLayout(latest, room, bodyRows, false, columns).rows;
        return { ...latest, feeds: { ...latest.feeds, [selectedId!]: {
          ...toggleForumPosts(room, latest.nowMs, columns, currentRows, latest.feeds?.[selectedId!]), surface: e.surface,
        } } };
      });
    };
    const select = async (id: string) => {
      await writeView($, latest => (visibleSessions(latest).some(job => job.id === id) || visibleForums(latest).some(room => forumId(room) === id))
        ? normalizeSessions({ ...latest, selectedId: id, forumRooms: latest.forumRooms?.map(room => forumId(room) === id
          ? { ...room, viewedPosts: room.postCount } : room), feeds: { ...latest.feeds,
          [id]: latest.feeds?.[id] ?? { feedOffset: 0, following: true, seenLines: 0 } } }) : latest);
      await poll?.(true);
    };
    // Budget the drawn rows, not the retained messages. Reserve 36k for the
    // (bounded) job list, footer and Button labels. Offscreen bodies stay whole.
    let remaining = 64_000;
    let styles = 1800;
    const drawSpans = (spans: Span[]) => {
      if (spans.length > styles) spans = [{ text: spans.map(span => span.text).join('') }];
      styles -= spans.length;
      return spans.map(span => {
      let text = span.text;
      if (text.length > remaining) text = remaining > 0
        ? `${limitChars(text, remaining - 1)}…` : '';
      remaining -= text.length;
      return <Text color={span.color} bold={span.bold} italic={span.italic} dimColor={span.dim}
        wrap="truncate-end">{text}</Text>;
    }); };
    const tableEntries = [...header.forumRooms, ...header.jobs];
    return <Box key="pane" flexDirection="column" width={columns} height={engineOffset + bodyRows + 1} minHeight={0} flexShrink={1}>
      {engineOffset > 0 && <Box key="engine-offset-pad" height={engineOffset} flexShrink={0} />}
      {!!header.titleRows && <Box key="list-title" height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">{drawSpans(listTitle(state, columns))}</Text>
      </Box>}
      {header.forumRooms.map(room => <Box key={`header-${forumId(room)}`} height={1} flexShrink={0} overflow="hidden">
        <Button key={forumId(room)} plain onPress={() => select(forumId(room))}><Text wrap="truncate-end">
          {drawSpans(tableRow(room, selectedId === forumId(room), columns, state, tableEntries))}</Text></Button>
      </Box>)}
      {header.jobs.map(job => <Box key={`header-${job.id}`} height={1} flexShrink={0} overflow="hidden">
        <Button key={job.id} plain onPress={() => select(job.id)}><Text wrap="truncate-end">
          {drawSpans(tableRow(job, selectedId === job.id, columns, state, tableEntries))}</Text></Button>
      </Box>)}
      {(header.toggle || header.clear) && <Box key="header-toggle" flexDirection="row" height={1} flexShrink={0} overflow="hidden">
        {headerToggle && <Button key="toggle-jobs" plain hotkey={compactToggle ? 'j' : undefined} onPress={async () => {
          await writeView($, latest => {
            const current = selectedJob(latest);
            const pages = paneLayout(latest, current, bodyRows).header.pageCount ?? 1;
            const nextPage = (latest.historyPage ?? 0) + 1;
            return !latest.jobsExpanded ? { ...latest, jobsExpanded: true, historyPage: 0 }
              : nextPage < pages ? { ...latest, historyPage: nextPage } : { ...latest, jobsExpanded: false, historyPage: 0 };
          });
        }}><Text color="subtle" wrap="truncate-end">{toggleText}</Text></Button>}
        {headerToggle && headerClear && <Text>  </Text>}
        {headerClear && <Button key="clear-finished" plain hotkey={clearHotkey} onPress={clear}><Text color="subtle">{clearText}</Text></Button>}
      </Box>}
      {header.rows > 0 && <Box key="header-rule" height={1} flexShrink={0}>
        <Text color="subtle" wrap="truncate-end">{'─'.repeat(columns)}</Text>
      </Box>}
      {top.map((spans, i) => <Box key={`forum-pinned-${i}`} height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">{drawSpans(spans)}</Text>
      </Box>)}
      <Box key="transcript" flexDirection="column" height={rows} minHeight={0} flexShrink={1} overflow="hidden">
        {Array.from({ length: rows }, (_, i) => {
          const line = window.lines[i];
          return <Box key={line?.key ?? `padding-${i}`} height={1} flexShrink={0} overflow="hidden">
            {line?.togglePostId ? <Button key={`toggle-post-${line.key}`} plain onPress={() => toggle(line.togglePostId!)}>
              <Text wrap="truncate-end">{drawSpans(line.spans)}</Text>
            </Button> : line?.togglePromptId ? <Button key={`toggle-prompt-${line.togglePromptId}`} plain onPress={() => toggle(line.togglePromptId!)}>
              <Text wrap="truncate-end">{drawSpans(line.spans)}</Text>
            </Button> : <Text wrap="truncate-end">{line?.spans.length ? drawSpans(line.spans) : ' '}</Text>}
          </Box>;
        })}
      </Box>
      {nameHint && <Box key="name-reuse-hint" height={1} flexShrink={0} overflow="hidden">
        <Text color="subtle" wrap="truncate-end">{fit(nameHint, columns)}</Text>
      </Box>}
      {footer && bodyRows > 2 && <Box key="footer-rule" height={1} flexShrink={0}><Text color="subtle" wrap="truncate-end">{'─'.repeat(columns)}</Text></Box>}
      {footer && bodyRows > 0 && <Box key="footer" flexDirection="row" height={1} flexShrink={0} overflow="hidden" gap={0}>
        <Box key="live-status" width={width(footer.left)} flexShrink={0}>
          <Text color={footer.color} wrap="truncate-end">{'leftSpans' in footer ? drawSpans(footer.leftSpans) : footer.left}</Text>
        </Box>
        {'toggle' in footer && <>
          <Text wrap="truncate-end">{footer.toggleGap}</Text>
          <Button key="toggle-forum-posts" plain onPress={toggleAll}><Text color="suggestion" wrap="truncate-end">{footer.toggle}</Text></Button>
        </>}
        <Text wrap="truncate-end">{footer.gap}</Text>
        {footer.right && <Text key="footer-tokens" color="subtle" wrap="truncate-end">{footer.right}</Text>}
        {!window.following && !failure && !state.discoveryWarning && <Button key="jump-bottom" plain hotkey="b" onPress={jumpToBottom}>
          <Text color="suggestion" wrap="truncate-end">{footer.jump}</Text></Button>}
        {tinyHistory && <Button key="toggle-jobs" plain hotkey="j" onPress={() => {
          const index = compactIds.indexOf(selectedId!);
          return select(compactIds[(index + 1) % compactIds.length]!);
        }}><Text color="subtle" wrap="truncate-end">{historyText}</Text></Button>}
        {tinyClear && columns >= clearWidth + 2 && <Text>  </Text>}
        {tinyClear && <Button key="clear-finished" plain hotkey={clearHotkey} onPress={clear}><Text color="subtle">{clearText}</Text></Button>}
      </Box>}
      <Box key="scroll-sentinel" height={1} flexShrink={0}><Text wrap="truncate-end"> </Text></Box>
    </Box>;
  });
};
