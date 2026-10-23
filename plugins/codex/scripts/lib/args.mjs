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
            (config.rejectUnknown && inlineValue === undefined && nextValue === "--")) {
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
      if (nextValue === undefined || (config.rejectUnknown && nextValue === "--")) {
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

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
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
