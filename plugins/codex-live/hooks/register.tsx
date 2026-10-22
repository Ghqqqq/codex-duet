import { atom, read } from 'claude-code';
import type { Register, Timer } from 'claude-code';
import type { CodexLiveState } from '../types';
import { feedLines, feedWindow, fit, footerLayout, paneLayout, jobRow, jobRowColor,
  messageLines, scrollFeed, selectedJob, width } from './layout';
import type { Span } from './layout';
import { clearFinished, jobLifecycle, normalizeSessions, visibleSessions } from './model';
import { createPoller } from './poll';
import { updateFailure, viewports, writeView } from './runtime';

const view = atom({ plugin: 'codex-live', key: 'view' } as const,
  { jobs: [], selectedId: null, nowMs: 0 } as CodexLiveState);
import { limitChars } from './text';

export const register: Register = on => {
  let timer: Timer | undefined;
  // ui.scroll has rows but no columns. Keep measurements per surface;
  // content anchors survive different wrapping without render-time state writes.
  let poll: ReturnType<typeof createPoller> | undefined;
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'codex-live', description: 'Open the read-only Codex jobs pane' });
    if (!timer) { poll = createPoller($); timer = $.clock.every(1000, () => poll!()); }
    return next(e);
  });

  on('command.run', { command: 'codex-live' }, async $ => {
    await $.ui.open({ id: 'codex-live', title: 'Codex', focus: true });
    return { text: 'Codex pane opened.' };
  });

  on('ui.scroll', { component: 'Pane', requestId: 'codex-live' }, async ($, e) => {
    const surface = await $.session.surface().catch(() => null);
    const measured = viewports.get(surface ?? 'terminal') ?? viewports.values().next().value;
    const columns = measured?.columns ?? 0;
    if (!columns || !e.by) return {};
    await writeView($, state => {
      state = normalizeSessions(state);
      const job = selectedJob(state);
      if (!job) return state;
      const { bodyRows, pinnedRows, rows } = paneLayout(state, job, e.bodyRows);
      // A wheel over pinned chrome does not move the transcript beneath it.
      if (e.pointer && (e.pointer.row < pinnedRows || e.pointer.row >= bodyRows - 1 ||
          e.pointer.column < 0 || e.pointer.column >= columns)) return state;
      const lines = feedLines(job, state.nowMs, columns);
      const next = scrollFeed(lines, rows, state.feeds?.[job.id], e.by, bodyRows, e.contentRows, !!e.pointer);
      return { ...state, feeds: { ...state.feeds, [job.id]: { ...next, columns, surface: surface ?? 'terminal' } } };
    });
    // Consume the move; render compensates for any retained engine offset.
    return {};
  }).catch(() => ({ deny: 'Codex feed kept its window' }));

  on('ui.render', { component: 'Pane', requestId: 'codex-live' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const state = normalizeSessions(await read($, view));
    const columns = Math.max(0, Math.floor(e.props.bodyColumns));
    const failure = updateFailure();
    const selected = selectedJob(state);
    const { bodyRows, header, rows } = paneLayout(state, selected, e.props.scroll.bodyRows, !!failure);
    viewports.set(e.surface, { columns, bodyRows });
    const engineOffset = Math.max(0, Math.floor(e.props.scroll.offset));
    const jobs = visibleSessions(state);
    const lines = selected ? feedLines(selected, state.nowMs, columns)
      : messageLines('No Codex jobs in this session yet. They appear here when Claude starts one.', columns)
        .map((spans, i) => ({ key: `empty-${i}`, spans: spans.map(span => ({ ...span, color: 'subtle' as const })) }));
    if (!selected && (state.hiddenFinishedBefore !== undefined || state.hiddenJobIds?.length)) lines.push({ key: 'hidden-notice',
      spans: [{ text: fit('Finished jobs are hidden. Their records stay for 30 days.', columns), color: 'subtle' }] });
    const window = selected ? feedWindow(lines, rows, state.feeds?.[selected.id]) : { lines: lines.slice(0, rows), following: true, newLines: 0 };
    const clearText = 'Clear finished';
    const canClear = jobs.some(job => jobLifecycle(job).finished) && columns >= width(clearText);
    const tinyClear = !!selected && !header.rows && canClear;
    const historyText = `+${jobs.length - 1} more`;
    const tinyHistory = !!selected && jobs.length > 1 && !header.rows &&
      width(historyText) + 3 <= columns - (tinyClear ? width(clearText) + 2 : 0);
    const footerColumns = Math.max(0, columns - (tinyHistory ? width(historyText) + 4 : 0)
      - (tinyClear ? width(clearText) + 2 : 0));
    const toggleText = header.more ? `+${header.more} more` : '− Show fewer';
    const headerClear = !!header.clear && canClear;
    const headerToggle = header.toggle && width(toggleText) <= columns - (headerClear ? width(clearText) + 2 : 0);
    const clear = async () => {
      const now = await $.clock.now();
      await writeView($, latest => clearFinished(latest, now));
      await poll?.(true);
    };
    const footer = failure ? { left: fit(`Pane update failed · ${failure}`, footerColumns), jump: '', gap: '', color: 'error' as const }
      : selected ? footerLayout(selected, state, footerColumns, window.following, window.newLines) : undefined;
    const jumpToBottom = async () => {
      await writeView($, latest => ({ ...latest, feeds: { ...latest.feeds,
        [selected!.id]: { feedOffset: 0, following: true, seenLines: 0 } } }));
    };
    const select = async (id: string) => {
      await writeView($, latest => visibleSessions(latest).some(job => job.id === id)
        ? normalizeSessions({ ...latest, selectedId: id, feeds: { ...latest.feeds,
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
      return <Text color={span.color} bold={span.bold} strikethrough={span.strikethrough}
        wrap="truncate-end">{text}</Text>;
    }); };
    return <Box key="pane" flexDirection="column" width={columns} height={engineOffset + bodyRows + 1} minHeight={0} flexShrink={1}>
      {engineOffset > 0 && <Box key="engine-offset-pad" height={engineOffset} flexShrink={0} />}
      {header.jobs.map(job => {
        const isSelected = selected?.id === job.id;
        const row = jobRow(job, isSelected, columns, state.nowMs, state.newSessionIds?.includes(job.id));
        return <Box key={`header-${job.id}`} height={1} flexShrink={0} overflow="hidden">
          <Button key={job.id} plain onPress={() => select(job.id)}><Text wrap="truncate-end"><Text color="suggestion">{row.selector}</Text><Text
            color={jobRowColor(job)}>{row.bullet}</Text><Text bold={isSelected} color="text">{row.label}</Text>
            <Text color="subtle">{row.summary}</Text><Text color="suggestion">{row.marker}</Text>{row.gap}<Text color="subtle">{row.meta}</Text></Text></Button>
        </Box>;
      })}
      {(header.toggle || header.clear) && <Box key="header-toggle" flexDirection="row" height={1} flexShrink={0} overflow="hidden">
        {headerToggle && <Button key="toggle-jobs" plain onPress={async () => {
          await writeView($, latest => {
            const current = selectedJob(latest);
            const pages = paneLayout(latest, current, bodyRows).header.pageCount ?? 1;
            const nextPage = (latest.historyPage ?? 0) + 1;
            return !latest.jobsExpanded ? { ...latest, jobsExpanded: true, historyPage: 0 }
              : nextPage < pages ? { ...latest, historyPage: nextPage } : { ...latest, jobsExpanded: false, historyPage: 0 };
          });
        }}><Text color="subtle" wrap="truncate-end">{toggleText}</Text></Button>}
        {headerToggle && headerClear && <Text>  </Text>}
        {headerClear && <Button key="clear-finished" plain onPress={clear}><Text color="subtle">{clearText}</Text></Button>}
      </Box>}
      {header.rows > 0 && <Box key="header-rule" height={1} flexShrink={0}>
        <Text color="subtle" wrap="truncate-end">{'─'.repeat(columns)}</Text>
      </Box>}
      <Box key="transcript" flexDirection="column" height={rows} minHeight={0} flexShrink={1} overflow="hidden">
        {Array.from({ length: rows }, (_, i) => {
          const line = window.lines[i];
          return <Box key={line?.key ?? `padding-${i}`} height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate-end">{line?.spans.length ? drawSpans(line.spans) : ' '}</Text>
          </Box>;
        })}
      </Box>
      {footer && bodyRows > 0 && <Box key="footer" flexDirection="row" height={1} flexShrink={0} overflow="hidden" gap={0}>
        <Box key="live-status" width={width(footer.left)} flexShrink={0}>
          <Text color={footer.color} wrap="truncate-end">{footer.left}</Text>
        </Box>
        <Text wrap="truncate-end">{footer.gap}</Text>
        {!window.following && !failure && <Button key="jump-bottom" plain hotkey="b" onPress={jumpToBottom}>
          <Text color="suggestion" wrap="truncate-end">{footer.jump}</Text></Button>}
        {tinyHistory && <Button key="toggle-jobs" plain hotkey="j" onPress={() => {
          const index = jobs.findIndex(job => job.id === selected!.id);
          return select(jobs[(index + 1) % jobs.length]!.id);
        }}><Text color="subtle" wrap="truncate-end">{historyText}</Text></Button>}
        {tinyClear && columns >= width(clearText) + 2 && <Text>  </Text>}
        {tinyClear && <Button key="clear-finished" plain onPress={clear}><Text color="subtle">{clearText}</Text></Button>}
      </Box>}
      <Box key="scroll-sentinel" height={1} flexShrink={0}><Text wrap="truncate-end"> </Text></Box>
    </Box>;
  });
};
