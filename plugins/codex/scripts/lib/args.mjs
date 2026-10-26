function optionDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  for (const key of repeatableOptions) valueOptions.add(key);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  // Opt in: other callers may intentionally forward option-like positionals.
  // Check before consuming values so a misspelled flag cannot become a value.
  if (config.rejectUnknown || config.rejectOptionTypos) {
    for (const token of argv) {
      if (token === "--") break;
      if (!token.startsWith("-") || token === "-") continue;
      const rawKey = token.startsWith("--") ? token.slice(2).split("=", 1)[0] : token.slice(1);
      const key = aliasMap[rawKey] ?? rawKey;
      if (!booleanOptions.has(key) && !valueOptions.has(key)) {
        const suggestion = config.rejectOptionTypos
          ? [...valueOptions, ...booleanOptions]
            .map(option => ({ option, distance: optionDistance(rawKey, option) }))
            .filter(candidate => candidate.distance <= 2)
            .sort((left, right) => left.distance - right.distance)[0]?.option
          : null;
        if (!config.rejectUnknown && !suggestion) continue;
        const error = new Error(`Unknown option: ${token}${suggestion ? ` (did you mean --${suggestion}?)` : ""}`);
        error.code = "UNKNOWN_OPTION";
        throw error;
      }
    }
  }
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const rawKey = token.slice(2, separator < 0 ? undefined : separator);
      const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (repeatableOptions.has(key) && nextValue.startsWith("-")) ||
            ((config.rejectUnknown || config.rejectSeparatorValues) && inlineValue === undefined && nextValue === "--")) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        if (repeatableOptions.has(key)) (options[key] ??= []).push(nextValue);
        else options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || ((config.rejectUnknown || config.rejectSeparatorValues) && nextValue === "--")) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      if (repeatableOptions.has(key)) (options[key] ??= []).push(nextValue);
      else options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw, options = {}) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (options.literalAfterSeparator && !quote && !escaping && !current &&
        raw.slice(index, index + 2) === "--" && (index === 0 || /\s/.test(raw[index - 1])) &&
        (index + 2 === raw.length || /\s/.test(raw[index + 2]))) {
      tokens.push("--");
      const focus = raw.slice(index + 2).trim();
      if (focus) tokens.push(focus);
      return tokens;
    }
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// Read only an option or its value. Offsets let the first focus token and its
// entire tail remain raw, including unmatched quotes and ordinary apostrophes.
function readRawOptionToken(raw, offset) {
  while (/\s/.test(raw[offset] ?? "") && offset < raw.length) offset += 1;
  const start = offset;
  let value = "", quote = null, escaping = false;
  for (; offset < raw.length; offset += 1) {
    const character = raw[offset];
    if (escaping) { value += character; escaping = false; }
    else if (character === "\\") escaping = true;
    else if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) break;
    else value += character;
  }
  if (escaping) value += "\\";
  return start < raw.length ? { start, end: offset, value } : null;
}

function rawSeparatorOffset(raw) {
  let quote = null, escaping = false, tokenStart = true;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaping) { escaping = false; continue; }
    if (character === "\\") { escaping = true; tokenStart = false; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; tokenStart = false; continue; }
    if (/\s/.test(character)) { tokenStart = true; continue; }
    if (tokenStart && raw.slice(index, index + 2) === "--" &&
        (index + 2 === raw.length || /\s/.test(raw[index + 2]))) return index;
    tokenStart = false;
  }
  return -1;
}

export function splitReviewArgumentString(raw, config = {}) {
  const separator = rawSeparatorOffset(raw);
  if (separator >= 0) {
    // Explicit separators retain the existing literal-tail contract, including
    // literal trailing --wait/--background/--json in the focus.
    return [...splitRawArgumentString(raw.slice(0, separator)), "--", raw.slice(separator + 2).trim()];
  }

  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliases = config.aliasMap ?? {};
  const tokens = [];
  let offset = 0;
  while (offset < raw.length) {
    const token = readRawOptionToken(raw, offset);
    if (!token) break;
    const isOption = token.value.startsWith("-") && token.value !== "-";
    const rawKey = token.value.startsWith("--") ? token.value.slice(2).split("=", 1)[0] : token.value.slice(1);
    const key = aliases[rawKey] ?? rawKey;
    const takesValue = isOption && valueOptions.has(key);
    if (!takesValue && !(isOption && booleanOptions.has(key)) && !["--help", "-h"].includes(token.value)) {
      // Preserve the existing unknown-option/typo diagnostic, but only while
      // still in option position. Nothing in the focus is parsed as an option.
      if (isOption) parseArgs([token.value], config);
      let focus = raw.slice(token.start).trim();
      const trailing = [];
      for (let match; (match = /(?:^|\s)(--wait|--background|--json)$/.exec(focus));) {
        trailing.unshift(match[1]);
        focus = focus.slice(0, match.index).trimEnd();
      }
      return [...tokens, ...trailing, "--", focus];
    }
    tokens.push(token.value);
    offset = token.end;
    if (takesValue && !(token.value.startsWith("--") && token.value.includes("="))) {
      const value = readRawOptionToken(raw, offset);
      if (!value) break; // parseArgs supplies the existing missing-value error.
      tokens.push(value.value);
      offset = value.end;
    }
  }
  return tokens;
}

// Common companion option: propagate it to helpers and detached workers too.
export function parseSessionArgs(argv, config = {}) {
  const parsed = parseArgs(argv, { ...config, valueOptions: [...(config.valueOptions ?? []), "session"] });
  if (parsed.options.session !== undefined) {
    const session = parsed.options.session.trim();
    if (!session || session.startsWith("-")) throw new Error("Provide a non-empty session ID for --session.");
    process.env.CODEX_COMPANION_SESSION_ID = session;
  }
  return parsed;
}
