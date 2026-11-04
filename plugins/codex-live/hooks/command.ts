import { cells, clusters, fit, width } from './text';

// Display only. Operators are distinct tokens only outside shell quoting.
type Word = { text: string; start: number; end: number; operator?: boolean; redirection?: boolean; delimiter?: string };
// Keep shell syntax distinct from literal arguments when the row is fitted again.
type DisplayWords = readonly string[] & { redirections?: readonly number[] };
function groupEnd(command: string, start: number): number {
  const backtick = command[start] === '`';
  let depth = 0, quote = '';
  for (let i = start; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (backtick) { if (i > start && ch === '`') return i; }
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return command.length - 1;
}
function syntaxPrefix(command: string, start: number, pattern: RegExp): { text: string; end: number } {
  const text = pattern.exec(command.slice(start).replace(/\\\n/g, ''))?.[0] ?? '';
  let end = start;
  for (let i = 0; i < text.length; i++) {
    while (command.startsWith('\\\n', end)) end += 2;
    end++;
  }
  return { text, end };
}
export function tokenize(command: string): Word[] {
  const words: Word[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let heredoc: { stripTabs: boolean; end: number } | undefined;
  let text = '', quote = '', started = false, start = 0;
  const flush = (end: number) => {
    if (started) {
      const word: Word = { text, start, end };
      if (heredoc) {
        const spaced = command.slice(heredoc.end, start).replace(/\\\n/g, '').length > 0;
        word.delimiter = (spaced ? ' ' : '') + command.slice(start, end);
        heredocs.push({ delimiter: text, stripTabs: heredoc.stripTabs });
        heredoc = undefined;
      }
      words.push(word);
    }
    text = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (!started) start = i;
    if (quote === "'") { if (ch === "'") quote = ''; else text += ch; continue; }
    if (quote === '"') {
      if (ch === '(' && text.endsWith('$') || ch === '`') {
        const end = groupEnd(command, i); text += command.slice(i, end + 1); i = end;
      } else if (ch === '"') quote = '';
      else if (ch === '\\' && /["\\$`\n]/.test(command[i + 1] ?? '')) {
        const next = command[++i]!; if (next !== '\n') text += next;
      } else text += ch;
      continue;
    }
    const redirect = '<>&'.includes(ch) ? syntaxPrefix(command, i, /^(?:&>>|&>|<<<|<<-|<<|>>|>&|<&|>\||>|<)/) : undefined;
    if (ch === '(' || ch === '`') {
      const end = groupEnd(command, i); text += command.slice(i, end + 1); i = end; started = true;
    } else if (ch === "'" || ch === '"') { quote = ch; started = true; }
    else if (ch === '\\') { const next = command[++i]; if (next !== '\n') { started = true; if (next) text += next; } }
    else if (ch === '\n') {
      flush(i);
      words.push({ text: '\n', operator: true, start: i, end: i + 1 });
      let cursor = i + 1;
      for (const document of heredocs) {
        while (cursor < command.length) {
          const newline = command.indexOf('\n', cursor);
          const end = newline < 0 ? command.length : newline;
          const line = command.slice(cursor, end);
          cursor = newline < 0 ? command.length : end + 1;
          if ((document.stripTabs ? line.replace(/^\t+/, '') : line) === document.delimiter) break;
        }
      }
      if (heredocs.length) i = cursor - 1;
      heredocs.length = 0;
    }
    else if (/\s/.test(ch)) flush(i);
    else if (redirect?.text) {
      const at = started && /^\d+$/.test(text) && command.slice(start, i).replace(/\\\n/g, '') === text ? start : i;
      const fd = at < i ? text : '';
      if (fd) { text = ''; started = false; } else flush(i);
      const operator = redirect.text;
      i = redirect.end - 1;
      // An adjacent fd duplication is one display token: 2>&1, 1>&2, 0<&3.
      const target = /[<>]&$/.test(operator) ? syntaxPrefix(command, i + 1, /^(?:\d+|-)(?=$|[\s;&|<>])/) : { text: '', end: i + 1 };
      i = target.end - 1;
      words.push({ text: fd + operator + target.text, redirection: true, start: at, end: i + 1 });
      if (operator === '<<' || operator === '<<-') heredoc = { stripTabs: operator === '<<-', end: i + 1 };
    }
    else if (';&|'.includes(ch)) {
      flush(i); const at = i;
      const operator = syntaxPrefix(command, i, /^(?:&&|\|\||[;&|])/);
      i = operator.end - 1;
      words.push({ text: operator.text, operator: true, start: at, end: i + 1 });
    } else { text += ch; started = true; }
  }
  flush(command.length);
  return words;
}
const assignment = (word: Word | undefined) => !!word && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);
const quoteWord = (word: string) => /^(?:[A-Za-z0-9_@%+=:,./-]+|~(?:\/[A-Za-z0-9_@%+=:,./-]*)?)$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
const basename = (word: string) => word.split(/[\\/]/).at(-1) ?? word;
function relative(word: string, cwd?: string, home?: string): string {
  for (const [root, prefix] of [[cwd, ''], [home, '~/']] as const) {
    if (!root) continue;
    const dir = root.replace(/[\\/]$/, '');
    if (word === dir) return prefix ? '~' : '.';
    if (word.startsWith(`${dir}/`)) return prefix + word.slice(dir.length + 1);
  }
  return word;
}
function middle(word: string): string {
  if (width(word) <= 40) return word;
  const chars = clusters(word);
  let left = '', right = '';
  for (const ch of chars) { if (width(left) + cells(ch) > 24) break; left += ch; }
  for (const ch of [...chars].reverse()) { if (width(right) + cells(ch) > 15) break; right = ch + right; }
  return `${left}…${right}`;
}

// Width is known only at the row, after reserving its indent and status.
// Paths keep their basename and lose whole leading segments, longest first.
export function fitCommand(program: string, args: DisplayWords, columns = Infinity, shorten = true, quote = true): { verb: string; args: string } {
  const words = [program, ...args].map((value, index) => {
    const redirection = args.redirections?.includes(index - 1) ?? false;
    const path = !redirection && value.includes('/') && !value.startsWith('-');
    const text = shorten && !path && !redirection ? middle(value) : value;
    const quoted = quote && !redirection && quoteWord(value) !== value;
    return { text: quoted ? quoteWord(text) : text, path,
      quoted, parts: value.split('/').filter(Boolean).filter((part, i) => i !== 0 || part !== '…'), dropped: 0 };
  });
  const length = () => words.reduce((sum, word) => sum + width(word.text), Math.max(0, words.length - 1));
  while (shorten && length() > columns) {
    const paths = words.filter(word => word.path && word.dropped < word.parts.length - 1)
      .sort((a, b) => width(b.text) - width(a.text));
    const word = paths[0];
    if (!word) break;
    const text = `…/${word.parts.slice(++word.dropped).join('/')}`;
    word.text = word.quoted ? quoteWord(text) : text;
  }
  const verb = words[0]!.text;
  const text = words.slice(1).map(word => word.text).join(' ');
  return { verb, args: shorten ? fit(text, Math.max(0, columns - width(verb) - 1)) : text };
}

function skipEnvironment(words: Word[]): Word[] {
  let index = 0;
  while (assignment(words[index])) index++;
  if (basename(words[index]?.text ?? '') === 'env') {
    index++;
    while (index < words.length) {
      if (words[index]!.text === '-u') index += 2;
      else if (words[index]!.text === '-i' || assignment(words[index])) index++;
      else if (words[index]!.text === '--') { index++; break; }
      else break;
    }
  }
  return words.slice(index);
}

export function commandDisplay(raw: string, cwd?: string, home?: string, shorten = true): { verb: string; args: string; more: number; program: string; words: string[] } {
  let tokens = tokenize(raw);
  for (let depth = 0; depth < 4 && tokens.every(token => !token.operator); depth++) {
    const words = skipEnvironment(tokens);
    const program = basename(words[0]?.text ?? '');
    if (!['sh', 'bash', 'zsh', 'dash'].includes(program)) break;
    const flag = words[1]?.text;
    const script = ['-c', '-lc'].includes(flag ?? '') ? 2 : flag === '-l' && words[2]?.text === '-c' ? 3 : -1;
    if (script < 0 || words.length !== script + 1) break;
    tokens = tokenize(words[script]!.text);
  }
  const parts: Word[][] = [[]];
  for (const word of tokens) {
    if (word.operator && ['&&', '||', ';', '|', '\n'].includes(word.text)) {
      if (parts.at(-1)!.length) parts.push([]);
    } else parts.at(-1)!.push(word);
  }
  const commands = parts.filter(part => part.length);
  let words = skipEnvironment(commands[0] ?? []);
  const rawProgram = words.shift()?.text ?? 'command';
  const name = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(rawProgram) ? basename(rawProgram) : rawProgram;
  if (name === 'git') {
    const kept: Word[] = [];
    while (words.length) {
      if (words[0]!.text === '-c' && words[1]) words.splice(0, 2);
      else if (words[0]!.text === '-C' && words[1]) kept.push(...words.splice(0, 2));
      else break;
    }
    words = [...kept, ...words];
  }
  const more = Math.max(0, commands.length - 1);
  const args = Object.assign([] as string[], { redirections: [] as number[] });
  for (const [index, word] of words.entries()) {
    if (word.delimiter !== undefined && args.length && words[index - 1]?.redirection) {
      args[args.length - 1] += word.delimiter;
    } else {
      if (word.redirection) args.redirections.push(args.length);
      args.push(word.redirection ? word.text : relative(word.text, cwd, home));
    }
  }
  const display = fitCommand(name, args, Infinity, shorten);
  return { ...display, args: display.args + (more ? `${display.args ? ' ' : ''}+${more}` : ''), more, program: name, words: args };
}
