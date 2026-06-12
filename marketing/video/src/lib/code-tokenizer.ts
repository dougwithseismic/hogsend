/**
 * Tiny deterministic TypeScript tokenizer for CodeScene. Not a parser —
 * just enough lexing for beautiful marketing code. No shiki, no async.
 *
 * Emphasis: wrap a range in ⟦double brackets⟧ in the source string and
 * those tokens render in the accent colour (the ONE accent per beat).
 */

export type TokenKind =
  | "keyword"
  | "string"
  | "func"
  | "number"
  | "comment"
  | "punctuation"
  | "property"
  | "plain";

export type Token = {
  text: string;
  kind: TokenKind;
  emphasis: boolean;
};

export type CodeLine = Token[];

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "await",
  "async",
  "import",
  "from",
  "export",
  "default",
  "new",
  "if",
  "else",
  "for",
  "of",
  "in",
  "type",
  "interface",
  "extends",
  "satisfies",
  "as",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "throw",
  "try",
  "catch",
]);

const EMPH_OPEN = "⟦"; // ⟦
const EMPH_CLOSE = "⟧"; // ⟧

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

/** Tokenizes a single line. `emphasis` state carries across tokens. */
const tokenizeLine = (line: string, state: { emphasis: boolean }): CodeLine => {
  const tokens: CodeLine = [];
  let i = 0;
  const push = (text: string, kind: TokenKind): void => {
    if (text.length === 0) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && last.emphasis === state.emphasis) {
      last.text += text;
    } else {
      tokens.push({ text, kind, emphasis: state.emphasis });
    }
  };

  while (i < line.length) {
    const c = line[i] as string;

    if (c === EMPH_OPEN) {
      state.emphasis = true;
      i += 1;
      continue;
    }
    if (c === EMPH_CLOSE) {
      state.emphasis = false;
      i += 1;
      continue;
    }
    // Comments — rest of line
    if (c === "/" && line[i + 1] === "/") {
      // strip emphasis markers inside comments too
      const rest = line
        .slice(i)
        .replaceAll(EMPH_OPEN, "")
        .replaceAll(EMPH_CLOSE, "");
      push(rest, "comment");
      break;
    }
    // Strings (no escapes needed for marketing snippets)
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) j += 1;
      push(line.slice(i, Math.min(j + 1, line.length)), "string");
      i = j + 1;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < line.length && /[0-9_.]/.test(line[j] as string)) j += 1;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    // Identifiers / keywords / function calls / properties
    if (isIdentChar(c)) {
      let j = i;
      while (j < line.length && isIdentChar(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      // peek past emphasis markers for the call-paren check
      let k = j;
      while (line[k] === EMPH_OPEN || line[k] === EMPH_CLOSE) k += 1;
      const prev = line[i - 1];
      if (KEYWORDS.has(word)) {
        push(word, "keyword");
      } else if (line[k] === "(") {
        push(word, "func");
      } else if (prev === ".") {
        push(word, "property");
      } else if (line[k] === ":") {
        push(word, "property");
      } else {
        push(word, "plain");
      }
      i = j;
      continue;
    }
    // Whitespace
    if (c === " " || c === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j += 1;
      push(line.slice(i, j), "plain");
      i = j;
      continue;
    }
    // Everything else is punctuation
    push(c, "punctuation");
    i += 1;
  }
  return tokens;
};

/** Tokenizes a full snippet into lines of tokens. */
export const tokenize = (code: string): CodeLine[] => {
  const state = { emphasis: false };
  return code
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => tokenizeLine(line, state));
};

/** Character count of a tokenized line (what the typewriter reveals). */
export const lineLength = (line: CodeLine): number =>
  line.reduce((n, t) => n + t.text.length, 0);
