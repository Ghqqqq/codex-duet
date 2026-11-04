import type { EngineInterface } from 'claude-code';
import type { CodexLiveState, ForumPost, ForumRoom } from '../types';
import { clean, cleanBody, isHiddenRoom } from './model';
import { limitChars } from './text';

const EVENT_BYTES = 4 * 1024 * 1024;
const POST_BUDGET = 400_000;
const roomPattern = /^rt-[a-z0-9]+-[a-z0-9-]+$/;
export const forumId = (room: ForumRoom) => `forum:${room.roomId}`;
export const forumOrder = (a: ForumRoom, b: ForumRoom) => Number(b.status === 'open') - Number(a.status === 'open') ||
  b.createdAt.localeCompare(a.createdAt) || b.roomId.localeCompare(a.roomId);
export const selectedForum = (state: CodexLiveState) => state.forumRooms?.find(room => forumId(room) === state.selectedId);

export async function isolatedHome($: EngineInterface): Promise<string> {
  const override = await $.env.get('CODEX_COMPANION_HOME');
  const userHome = await $.env.get('HOME') || await $.env.get('USERPROFILE');
  let home = override || (userHome ? `${userHome}/.claude/codex-isolated` : '');
  if (home && await $.fs.exists(home)) home = (await $.fs.stat(home, { resolve: true })).realPath || home;
  return home.replace(/\/$/, '');
}

function roomView(value: unknown, session: string, id: string): ForumRoom | undefined {
  if (!value || typeof value !== 'object') return;
  const room = value as Record<string, unknown>;
  if (room.roomId !== id || room.sessionId !== session || typeof room.goal !== 'string' ||
      typeof room.status !== 'string' || !['open', 'paused', 'closed'].includes(room.status) || typeof room.createdAt !== 'string' || !Number.isFinite(Date.parse(room.createdAt)) ||
      !Array.isArray(room.members) || room.members.length > 6 || room.members.some((member: { name?: unknown }) =>
        !member || typeof member.name !== 'string') || !Number.isSafeInteger(room.nextSeq) || (room.nextSeq as number) < 1) return;
  return { roomId: id, sessionId: session, goal: limitChars(cleanBody(room.goal), 10_000), status: room.status as ForumRoom['status'],
    intensity: limitChars(clean(room.intensity), 40), members: room.members.map((member: { name: string }) => limitChars(clean(member.name), 100)),
    createdAt: room.createdAt, postCount: (room.nextSeq as number) - 1 };
}

export async function readForumRoom($: EngineInterface, home: string, session: string, id: string): Promise<ForumRoom | undefined> {
  if (!home || id.length > 128 || !roomPattern.test(id)) return;
  try {
    const file = `${home}/duet/roundtables/${id}/room.json`;
    const stat = await $.fs.stat(file);
    if (stat.kind !== 'file' || stat.size > 64 * 1024) return;
    return roomView(JSON.parse(await $.fs.read(file)), session, id);
  } catch { return; }
}

function postView(value: unknown): ForumPost | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as ForumPost;
  if (!Number.isSafeInteger(p.seq) || p.seq < 1 || typeof p.at !== 'string' || !Number.isFinite(Date.parse(p.at)) ||
      !p.author || !['chair', 'member'].includes(p.author.kind) || typeof p.author.name !== 'string' ||
      !['idea', 'finding', 'question', 'request', 'intent', 'candidate', 'decision'].includes(p.kind) ||
      typeof p.body !== 'string' || p.body.length > 4000 ||
      p.title != null && (typeof p.title !== 'string' || p.title.length > 160) ||
      p.label != null && typeof p.label !== 'string' ||
      !Number.isSafeInteger(p.thread) || p.thread < 1 || p.thread > p.seq ||
      p.replyTo !== null && (!Number.isSafeInteger(p.replyTo) || p.replyTo < 1 || p.replyTo >= p.seq) ||
      !Array.isArray(p.refs) || p.refs.length > 16 || p.refs.some(ref => typeof ref !== 'string' || ref.length > 512) ||
      !Array.isArray(p.mentions) || p.mentions.length > 8 || p.mentions.some(name => typeof name !== 'string' || name.length > 100)) return;
  return { seq: p.seq, at: p.at, initial: p.initial === true, author: { kind: p.author.kind, name: limitChars(clean(p.author.name), 100) },
    kind: p.kind, thread: p.thread, replyTo: p.replyTo, title: clean(p.title), body: cleanBody(p.body),
    label: limitChars(clean(p.label), 100), refs: p.refs.map(clean), mentions: p.mentions.map(clean) };
}

// A single selected log is cached. Metadata stamps include malformed and
// foreign-session rooms, so unchanged historical files need only a stat. Never
// invoke forum CLI helpers: their reads can acknowledge cursors/repair journals.
const ROOM_READ_LIMIT = 16;
const ROOM_SCAN_LIMIT = 64;
type RoomMetadata = { size: number; mtime: number; room?: ForumRoom };
export function createForumPoller($: EngineInterface) {
  let session = '';
  let nextDiscovery = 0;
  let cursor = '';
  const metadata = new Map<string, RoomMetadata>();
  let rooms: ForumRoom[] = [];
  const logs = new Map<string, { size: number; mtime: number; room: ForumRoom }>();
  return async (home: string, sessionId: string, now: number, current: CodexLiveState): Promise<ForumRoom[]> => {
    if (session !== sessionId) {
      session = sessionId; nextDiscovery = 0; cursor = ''; metadata.clear(); rooms = []; logs.clear();
    }
    const selected = selectedForum(current);
    const discovering = now >= nextDiscovery;
    if (discovering) {
      nextDiscovery = now + 5000;
      try {
        const entries = await $.fs.list(`${home}/duet/roundtables`);
        const ids = entries.filter(entry => entry.kind === 'dir' && entry.name.length <= 128 && roomPattern.test(entry.name))
          .map(entry => entry.name).sort();
        const present = new Set(ids);
        for (const id of metadata.keys()) if (!present.has(id)) metadata.delete(id);
        let reads = 0;
        const checked = new Set<string>();
        const refresh = async (id: string): Promise<boolean> => {
          if (checked.has(id)) return true;
          checked.add(id);
          try {
            const file = `${home}/duet/roundtables/${id}/room.json`;
            const stat = await $.fs.stat(file);
            const previous = metadata.get(id);
            if (previous?.size === stat.size && previous.mtime === stat.mtimeMs) return true;
            if (stat.kind !== 'file' || stat.size > 64 * 1024) {
              metadata.set(id, { size: stat.size, mtime: stat.mtimeMs }); return true;
            }
            if (reads >= ROOM_READ_LIMIT) return false;
            reads++;
            const text = await $.fs.read(file);
            let room: ForumRoom | undefined;
            try { room = roomView(JSON.parse(text), session, id); }
            catch { /* One malformed room cannot abort discovery. */ }
            metadata.set(id, { size: stat.size, mtime: stat.mtimeMs, room });
          } catch { metadata.delete(id); }
          return true;
        };
        // Keep visible/selected metadata responsive while the remaining index
        // advances in bounded batches. Foreign entries retain only their stamp.
        for (const id of [selected?.roomId, ...rooms.map(room => room.roomId)]) {
          if (id && present.has(id)) await refresh(id);
        }
        const start = ids.findIndex(id => id > cursor);
        for (let i = 0; i < ids.length && checked.size < ROOM_SCAN_LIMIT; i++) {
          const id = ids[((start < 0 ? 0 : start) + i) % ids.length]!;
          if (!await refresh(id)) break;
          cursor = id;
        }
      } catch { /* A session without roundtables has no directory yet. */ }
    }
    // Refill from the cached index immediately after Clear finished, even
    // between discovery ticks. Tombstones never consume a displayed slot.
    rooms = [...metadata.values()].flatMap(entry => entry.room && !isHiddenRoom(current, entry.room) ? [entry.room] : [])
      .sort(forumOrder).slice(0, 3);
    const next = rooms.map(room => ({ ...room, viewedPosts: current.forumRooms?.find(old => old.roomId === room.roomId)?.viewedPosts }));
    if (selected && !next.some(room => room.roomId === selected.roomId)) {
      const fresh = metadata.has(selected.roomId) ? metadata.get(selected.roomId)?.room : selected;
      if (fresh) next.push({ ...fresh, posts: undefined, malformed: undefined, omitted: undefined, warning: undefined, viewedPosts: selected.viewedPosts });
    }
    // Timelines cover only the three displayed rooms plus an explicit older
    // selection. Unselected logs are checked on discovery ticks. Keep at most
    // four 400k projections privately so selection never rereads an unchanged
    // log; publish post bodies only for the selection, checked every second.
    for (const id of logs.keys()) if (!next.some(room => room.roomId === id)) logs.delete(id);
    for (const room of next) {
      const detailed = forumId(room) === current.selectedId;
      const cached = logs.get(room.roomId);
      if (!detailed && !discovering) {
        if (cached) Object.assign(room, { timeline: cached.room.timeline, postCount: cached.room.postCount });
        continue;
      }
      const file = `${home}/duet/roundtables/${room.roomId}/events.jsonl`;
      try {
        const stat = await $.fs.stat(file);
        const warning = `Forum exceeds 4 MiB · fugato forum read ${room.roomId}`;
        if (stat.size > EVENT_BYTES) Object.assign(room, { posts: [], timeline: [], warning });
        else if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
          Object.assign(room, { posts: cached.room.posts, timeline: cached.room.timeline, postCount: cached.room.postCount,
            malformed: cached.room.malformed, omitted: cached.room.omitted, warning: cached.room.warning });
        } else {
          const text = await $.fs.read(file);
          // The API has no ranged reads. Check before reading and reject logs
          // that crossed the limit during the stat/read race as well.
          const bytes = text.length <= EVENT_BYTES ? new TextEncoder().encode(text).length : text.length;
          if (bytes > EVENT_BYTES) Object.assign(room, { posts: [], timeline: [], warning });
          else {
            const posts: ForumPost[] = [];
            let malformed = 0;
            const sequences = new Set<number>();
            for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
              if (!line.trim()) continue;
              try {
                const post = postView(JSON.parse(line));
                if (!post || sequences.has(post.seq) || posts.length >= 5000) { malformed++; continue; }
                sequences.add(post.seq); posts.push(post);
              } catch { malformed++; }
            }
            posts.sort((a, b) => a.seq - b.seq);
            const timeline = posts.map(post => Date.parse(post.at) * (post.author.kind === 'chair' && post.kind === 'decision' ? -1 : 1));
            let size = 0, start = posts.length;
            while (start > 0) {
              const bytes = JSON.stringify(posts[start - 1]).length + 1;
              if (size + bytes > POST_BUDGET) break;
              size += bytes; start--;
            }
            Object.assign(room, { posts: posts.slice(start), timeline, postCount: posts.length, malformed, omitted: start });
          }
        }
        logs.set(room.roomId, { size: stat.size, mtime: stat.mtimeMs, room: { ...room } });
      } catch {
        logs.delete(room.roomId);
        Object.assign(room, { posts: [], timeline: [], warning: `Forum posts unavailable · fugato forum read ${room.roomId}` });
      }
      if (detailed) room.viewedPosts = room.postCount;
      else Object.assign(room, { posts: undefined, malformed: undefined, omitted: undefined, warning: undefined });
    }
    return next;
  };
}
