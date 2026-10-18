import { atom, read } from 'claude-code';
import type { Register, Timer } from 'claude-code';
import type { CodexLiveState } from '../types';
import { feedLines, feedWindow, fit, footerLayout, headerLayout, jobRow, jobState,
  messageLines, scrollFeed, selectedJob, width } from './layout';
import type { Span } from './layout';
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
      const job = selectedJob(state);
      if (!job) return state;
      const header = headerLayout(state, job, e.bodyRows);
      const rows = Math.max(0, e.bodyRows - header.rows - 1);
      // A wheel over pinned chrome does not move the transcript beneath it.
      if (e.pointer && (e.pointer.row < header.rows || e.pointer.row >= e.bodyRows - 1 ||
          e.pointer.column < 0 || e.pointer.column >= columns)) return state;
      const lines = feedLines(job, state.nowMs, columns);
      const next = scrollFeed(lines, rows, state.feeds?.[job.id], e.by, e.bodyRows, e.contentRows, !!e.pointer);
      return { ...state, feeds: { ...state.feeds, [job.id]: { ...next, columns, surface: surface ?? 'terminal' } } };
    });
    // Consume the move; render compensates for any retained engine offset.
    return {};
  }).catch(() => ({ deny: 'Codex feed kept its window' }));

  on('ui.render', { component: 'Pane', requestId: 'codex-live' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const state = await read($, view);
    const columns = Math.max(0, Math.floor(e.props.bodyColumns));
    const bodyRows = Math.max(0, Math.floor(e.props.scroll.bodyRows));
    viewports.set(e.surface, { columns, bodyRows });
    const engineOffset = Math.max(0, Math.floor(e.props.scroll.offset));
    const selected = selectedJob(state);
    const header = selected ? headerLayout(state, selected, bodyRows) : { jobs: [], toggle: false, more: 0, rows: 0 };
    const rows = Math.max(0, bodyRows - header.rows - (selected || updateFailure() ? 1 : 0));
    const lines = selected ? feedLines(selected, state.nowMs, columns)
      : messageLines('No Codex jobs in this session yet. They appear here when Claude starts one.', columns)
        .map((spans, i) => ({ key: `empty-${i}`, spans: spans.map(span => ({ ...span, color: 'subtle' as const })) }));
    const window = selected ? feedWindow(lines, rows, state.feeds?.[selected.id]) : { lines: lines.slice(0, rows), following: true, newLines: 0 };
    const failure = updateFailure();
    const tinyHistory = !!selected && state.jobs.length > 1 && !header.rows;
    const historyText = tinyHistory ? fit(`+${state.jobs.length - 1} more`, Math.max(0, columns - 3)) : '';
    const footerColumns = Math.max(0, columns - (tinyHistory ? width(historyText) + 4 : 0));
    const footer = failure ? { left: fit(`Pane update failed · ${failure}`, footerColumns), jump: '', gap: '', color: 'error' as const }
      : selected ? footerLayout(selected, state, footerColumns, window.following, window.newLines) : undefined;
    const select = async (id: string) => {
      await writeView($, latest => ({ ...latest, selectedId: id, feeds: { ...latest.feeds,
        [id]: { feedOffset: 0, following: true, seenLines: 0 } } }));
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
    return <Box key="pane" flexDirection="column" width={columns} height={engineOffset + bodyRows + 1} flexShrink={0}>
      {engineOffset > 0 && <Box key="engine-offset-pad" height={engineOffset} flexShrink={0} />}
      {header.jobs.map(job => {
        const isSelected = selected?.id === job.id;
        const row = jobRow(job, isSelected, columns, state.nowMs);
        return <Box key={`header-${job.id}`} height={1} flexShrink={0} overflow="hidden">
          <Button key={job.id} plain onPress={() => select(job.id)}><Text wrap="truncate-end"><Text color="suggestion">{row.selector}</Text><Text
            color={jobState(job).color}>{row.bullet}</Text><Text bold={isSelected} color="text">{row.label}</Text>
            {row.gap}<Text color="subtle">{row.meta}</Text></Text></Button>
        </Box>;
      })}
      {header.toggle && <Box key="header-toggle" height={1} flexShrink={0} overflow="hidden">
        <Button key="toggle-jobs" plain onPress={async () => {
          await writeView($, latest => {
            const current = selectedJob(latest);
            const pages = current ? headerLayout(latest, current, bodyRows).pageCount ?? 1 : 1;
            const nextPage = (latest.historyPage ?? 0) + 1;
            return !latest.jobsExpanded ? { ...latest, jobsExpanded: true, historyPage: 0 }
              : nextPage < pages ? { ...latest, historyPage: nextPage } : { ...latest, jobsExpanded: false, historyPage: 0 };
          });
        }}><Text color="subtle" wrap="truncate-end">{fit(header.more ? `+${header.more} more` : '− Show fewer', columns)}</Text></Button>
      </Box>}
      {header.rows > 0 && <Box key="header-rule" height={1} flexShrink={0}>
        <Text color="subtle" wrap="truncate-end">{'─'.repeat(columns)}</Text>
      </Box>}
      <Box key="transcript" flexDirection="column" height={rows} flexShrink={0}>
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
        {!window.following && !failure && <Button key="jump-bottom" plain hotkey="b" onPress={async () => {
          await writeView($, latest => ({ ...latest, feeds: { ...latest.feeds,
            [selected!.id]: { feedOffset: 0, following: true, seenLines: 0 } } }));
        }}><Text color="suggestion" wrap="truncate-end">{footer.jump}</Text></Button>}
        {tinyHistory && <Button key="toggle-jobs" plain hotkey="j" onPress={() => {
          const index = state.jobs.findIndex(job => job.id === selected!.id);
          return select(state.jobs[(index + 1) % state.jobs.length]!.id);
        }}><Text color="subtle" wrap="truncate-end">{historyText}</Text></Button>}
      </Box>}
      <Box key="scroll-sentinel" height={1} flexShrink={0}><Text wrap="truncate-end"> </Text></Box>
    </Box>;
  });
};
