// Display only: these words are never used to execute or classify a command.
// Keep shell syntax distinct from literal arguments while retaining the string
// methods used by the native row renderer (which also calls quoteWord).
class ShellSyntax extends String {}

function syntaxAt(command, start) {
  let source = '';
  const ends = [];
  for (let i = start; i < command.length; i++) {
    if (command[i] === '\\' && command[i + 1] === '\n') { i++; continue; }
    if (!/[\d<>&|;-]/.test(command[i])) break;
    source += command[i]; ends.push(i + 1);
  }
  // Join continuations before recognizing an operator, including 2>\\\n&1.
  const [value, redirection, operator] = source.match(/^(?:(\d*(?:&>>?|<<<|<<-|<<|>>|[<>]&|>\||[<>]))|(&&|\|\||;|\|))/) ?? [];
  return value ? { redirection, operator, end: ends[value.length - 1] } : null;
}

function substitutionEnd(command, start) {
  const backtick = command[start] === '`';
  let quote = '', depth = 1;
  for (let i = start + (backtick ? 1 : 2); i < command.length; i++) {
    const char = command[i], next = command[i + 1];
    if (backtick) {
      if (char === '\\') i++;
      else if (char === '`') return i + 1;
    } else if (quote === "'") {
      if (char === quote) quote = '';
    } else if (char === '\\') i++;
    else if (char === '`' || char === '$' && next === '(') i = substitutionEnd(command, i) - 1;
    else if (quote) { if (char === quote) quote = ''; }
    else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  return command.length;
}
export function shellTokens(command) {
  const tokens = [], heredocs = [];
  let word = '', raw = '', started = false, quote = '', depth = 0, redirect = null;
  const flush = () => {
    if (started) {
      if (redirect?.heredoc) {
        redirect.token.redirection += (redirect.spaced ? ' ' : '') + raw;
        heredocs.push({ delimiter: word, tabs: redirect.tabs });
      } else if (redirect && /[<>]&$/.test(redirect.token.redirection)
        && !redirect.spaced && raw === word && /^(?:\d+-?|-)$/.test(word)) {
        redirect.token.redirection += word;
      } else tokens.push({ word });
      redirect = null;
    }
    word = ''; raw = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i], next = command[i + 1];
    const syntax = !quote && !depth && ((!started && /\d/.test(char)) || '<>&|;'.includes(char))
      ? syntaxAt(command, i) : null;
    if (quote === "'") {
      raw += char;
      if (char === quote) quote = ''; else word += char;
    } else if (char === '\\' && quote !== "'") {
      if (next !== undefined && (!quote || '$`"\\\n'.includes(next))) {
        if (next !== '\n') { word += next; raw += char + next; started = true; }
        i++;
      } else { word += char; raw += char; started = true; }
    } else if (char === '`' || char === '$' && next === '(') {
      const end = substitutionEnd(command, i);
      word += command.slice(i, end); raw += command.slice(i, end); started = true; i = end - 1;
    } else if (quote) {
      raw += char;
      if (char === quote) quote = ''; else word += char;
    } else if (char === "'" || char === '"') {
      quote = char; raw += char; started = true;
    } else if (!depth && /\s/.test(char)) {
      flush();
      if (char === '\n') {
        tokens.push({ operator: '\n' });
        redirect = null;
        // Heredocs on one header line consume their bodies in declaration order.
        // An unfinished body is hidden through EOF as well.
        let at = i + 1;
        for (const { delimiter, tabs } of heredocs) {
          while (at < command.length) {
            const newline = command.indexOf('\n', at);
            const end = newline < 0 ? command.length : newline;
            const line = command.slice(at, end);
            at = newline < 0 ? command.length : end + 1;
            if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
          }
        }
        if (heredocs.length) { i = at - 1; heredocs.length = 0; }
      } else if (redirect) redirect.spaced = true;
    } else if (syntax?.redirection) {
      flush();
      const redirection = syntax.redirection;
      const token = { redirection };
      tokens.push(token);
      redirect = { token, heredoc: /^(?:\d+)?<<-?$/.test(redirection), tabs: redirection.endsWith('<<-'), spaced: false };
      i = syntax.end - 1;
    } else if (syntax?.operator) {
      flush();
      tokens.push({ operator: syntax.operator });
      redirect = null;
      i = syntax.end - 1;
    } else {
      if (char === '(' || char === '{') depth++;
      if (char === ')' || char === '}') depth = Math.max(0, depth - 1);
      word += char; raw += char; started = true;
    }
  }
  flush();
  return tokens;
}

export function displayPath(path, context = {}) {
  const cwd = context.cwd?.replace(/\/+$/, ''), home = context.home?.replace(/\/+$/, '');
  if (cwd && (path === cwd || path.startsWith(cwd + '/')) && !path.slice(cwd.length).split('/').includes('..')) return path.slice(cwd.length + 1) || '.';
  if (home && (path === home || path.startsWith(home + '/')) && !path.slice(home.length).split('/').includes('..')) return '~' + path.slice(home.length);
  return path;
}
export const quoteWord = word => word instanceof ShellSyntax || /^(?:[A-Za-z0-9_@%+=:,./-]+|~(?:\/[A-Za-z0-9_@%+=:,./-]*)?)$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
const assignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word ?? '');
const basename = word => word?.split('/').at(-1) ?? '';
function skipEnvironment(words) {
  let index = 0;
  while (assignment(words[index])) index++;
  if (basename(words[index]) === 'env') {
    index++;
    while (index < words.length) {
      if (words[index] === '-u') index += 2;
      else if (words[index] === '-i' || assignment(words[index])) index++;
      else if (words[index] === '--') { index++; break; }
      else break;
    }
  }
  return words.slice(index);
}
export function cleanCommand(command, context = {}) {
  let tokens = shellTokens(command);
  for (let depth = 0; depth < 4 && tokens.every(token => 'word' in token); depth++) {
    const words = skipEnvironment(tokens.map(token => token.word));
    if (!['sh', 'bash', 'zsh', 'dash'].includes(basename(words[0]))) break;
    const at = ['-c', '-lc'].includes(words[1]) ? 2 : words[1] === '-l' && words[2] === '-c' ? 3 : -1;
    if (at < 0 || words.length !== at + 1) break;
    tokens = shellTokens(words[at]);
  }
  const parts = [[]];
  for (const token of tokens) {
    if (token.operator) { if (parts.at(-1).length) parts.push([]); }
    else parts.at(-1).push(token.redirection === undefined ? token.word : new ShellSyntax(token.redirection));
  }
  const commands = parts.filter(part => part.length);
  let [program = '', ...words] = skipEnvironment(commands[0] ?? []);
  const verb = program.startsWith('/') ? basename(program) : program;
  if (verb === 'git') {
    const kept = [];
    while (words.length) {
      if (words[0] === '-c' && words.length > 1) words.splice(0, 2);
      else if (words[0] === '-C' && words.length > 1) kept.push(...words.splice(0, 2));
      else break;
    }
    words = [...kept, ...words];
  }
  words = words.map(word => word instanceof ShellSyntax ? word
    : word.replace(/^(--[^=]+=)?(\/.*)$/, (_, option, path) => (option ?? '') + displayPath(path, context)));
  const extra = Math.max(0, commands.length - 1);
  return { verb, words, extra, args: [...words.map(quoteWord), ...(extra ? [`+${extra}`] : [])].join(' ') };
}
