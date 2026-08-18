export type AutocompleteSuggestionSource =
  | "history"
  | "command"
  | "subcommand"
  | "option"
  | "argument"
  | "path";

export interface AutocompleteSuggestion {
  text: string;
  displayText: string;
  detail?: string;
  source: AutocompleteSuggestionSource;
  score: number;
  frequency?: number;
  isDirectory?: boolean;
  pathKind?: "file" | "directory" | "symlink";
}

export interface AutocompleteSpecResult {
  suggestions: AutocompleteSuggestion[];
  pathRequirement?: "files" | "folders";
}

export interface AutocompleteCommandLine {
  input: string;
  tokens: string[];
  currentWord: string;
  wordIndex: number;
  commandName: string;
}

const PROMPT_CHARACTERS = new Set([
  "$",
  "#",
  "%",
  ">",
  "❯",
  "❮",
  "→",
  "➜",
  "➤",
  "⟩",
  "»",
  "›",
]);
const NON_PROMPT_PATTERNS = [
  /^~$/,
  /^\s*--\s*more\s*--/i,
  /^\s*\(END\)/,
  /^:\s*$/,
  /^>{1,3}\s/,
  /^(?:mysql|sqlite(?:3)?|redis(?:-cli)?|psql|mariadb)>\s*/i,
  /^SQL>\s*/i,
  /^(?:sftp|ftp|lftp|ghci|node|mongo|mongosh|deno|irb|pry|julia|scala|gdb|lldb|cqlsh|hive|spark-sql|jshell|ksql|trino|presto|duckdb)>\s*/i,
  /^MariaDB\s+\[[^\]]+\]>\s*/i,
  /^[\w.-]+=[#>]\s*/,
  /^[\w.-]+[-'"][#>]\s*/,
];
const SENSITIVE_PROMPT =
  /(?:password|passphrase|verification\s+code|one[- ]time\s+(?:code|password)|otp|pin)\s*[:：]\s*$/i;

export function sourceBadge(source: AutocompleteSuggestionSource) {
  return {
    history: "h",
    command: "c",
    subcommand: "s",
    option: "o",
    argument: "a",
    path: "p",
  }[source];
}

export function mergeAutocompleteSuggestions(
  groups: AutocompleteSuggestion[][],
  maximum = 8,
) {
  const sorted = groups.flat().sort((left, right) => right.score - left.score);
  const seen = new Set<string>();
  const unique = sorted.filter((suggestion) => {
    if (seen.has(suggestion.text)) return false;
    seen.add(suggestion.text);
    return true;
  });
  return unique.slice(
    0,
    unique.some((suggestion) => suggestion.source === "path")
      ? Math.max(maximum, 24)
      : maximum,
  );
}

export function historyAutocompleteSuggestions(
  input: string,
  candidates: string[],
  maximum = 5,
) {
  if (!input.trim()) return [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  const query = input.toLowerCase();
  const prefix = [...counts.entries()]
    .filter(
      ([candidate]) =>
        candidate !== input && candidate.toLowerCase().startsWith(query),
    )
    .sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.length - right.length,
    );
  const selected = prefix.slice(0, maximum);
  if (selected.length < Math.min(3, maximum) && input.length >= 2) {
    const existing = new Set(selected.map(([candidate]) => candidate));
    selected.push(
      ...[...counts.entries()]
        .filter(
          ([candidate]) =>
            candidate !== input &&
            !existing.has(candidate) &&
            fuzzyMatches(query, candidate.toLowerCase()),
        )
        .sort(([, left], [, right]) => right - left)
        .slice(0, maximum - selected.length),
    );
  }
  return selected.map(([text, frequency]) => ({
    text,
    displayText: text,
    source: "history" as const,
    score: 1_000 + frequency,
    frequency,
  }));
}

export function parseAutocompleteCommandLine(
  input: string,
): AutocompleteCommandLine {
  const tokens: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === "'" && !doubleQuoted) {
      current += character;
      singleQuoted = !singleQuoted;
    } else if (character === '"' && !singleQuoted) {
      current += character;
      doubleQuoted = !doubleQuoted;
    } else if (character === " " && !singleQuoted && !doubleQuoted) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  tokens.push(current);
  const commandName = (tokens[0]?.split(/[\\/]/).at(-1) ?? "")
    .replace(/\.(?:exe|cmd|bat|sh|bash|zsh|fish)$/i, "")
    .toLowerCase();
  return {
    input,
    tokens,
    currentWord: current,
    wordIndex: Math.max(0, tokens.length - 1),
    commandName,
  };
}

export function replaceAutocompleteWord(
  context: AutocompleteCommandLine,
  replacement: string,
) {
  return (
    context.input.slice(0, -context.currentWord.length || undefined) +
    replacement
  );
}

export function isTerminalPrompt(renderedLine: string | undefined) {
  if (!renderedLine) return false;
  const line = renderedLine.replace(/[\r\n]+$/, "");
  if (
    !line ||
    NON_PROMPT_PATTERNS.some((pattern) => pattern.test(line.trim())) ||
    SENSITIVE_PROMPT.test(line)
  ) {
    return false;
  }
  return promptBoundary(line) != null;
}

export function commandFromTerminalPrompt(renderedLine: string | undefined) {
  if (!renderedLine) return undefined;
  const line = renderedLine.replace(/[\r\n]+$/, "");
  if (
    NON_PROMPT_PATTERNS.some((pattern) => pattern.test(line.trim())) ||
    SENSITIVE_PROMPT.test(line)
  ) {
    return undefined;
  }
  const boundary = promptBoundary(line);
  if (boundary == null) return undefined;
  const command = line.slice(boundary).trim();
  return command || undefined;
}

function promptBoundary(line: string) {
  let boundary: number | undefined;
  let scanned = 0;
  for (let index = 0; index < line.length && scanned < 200; index += 1) {
    const character = line[index]!;
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      !PROMPT_CHARACTERS.has(character) &&
      !(codePoint >= 0xe000 && codePoint <= 0xf8ff)
    ) {
      scanned += 1;
      continue;
    }
    const next = line[index + 1];
    if (next != null && next !== " ") {
      scanned += 1;
      continue;
    }
    const previous = line[index - 1];
    if (
      character === "$" &&
      previous != null &&
      "=/:".includes(previous)
    ) {
      scanned += 1;
      continue;
    }
    if (
      (character === ">" || character === "›") &&
      index >= Math.max(40, Math.max(1, line.trim().length) * 0.6)
    ) {
      scanned += 1;
      continue;
    }
    boundary = next === " " ? index + 2 : index + 1;
    scanned += 1;
  }
  return boundary;
}

function fuzzyMatches(query: string, candidate: string) {
  let candidateIndex = 0;
  for (const character of query) {
    const match = candidate.indexOf(character, candidateIndex);
    if (match < 0) return false;
    candidateIndex = match + 1;
  }
  return true;
}
