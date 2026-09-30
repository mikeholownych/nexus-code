import pc from "picocolors";

const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "default", "break", "continue", "new", "this", "class", "extends",
  "super", "import", "export", "from", "as", "default", "async", "await", "yield",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "interface",
  "type", "enum", "implements", "declare", "namespace", "abstract", "readonly",
  // Rust
  "fn", "pub", "struct", "enum", "impl", "trait", "match", "mut", "ref", "self",
  "Self", "use", "mod", "crate", "where", "move", "unsafe", "loop",
  // Python
  "def", "class", "lambda", "with", "pass", "raise", "except", "elif",
  // Go
  "func", "package", "go", "chan", "select", "defer",
  // SQL
  "select", "insert", "update", "delete", "create", "table", "where", "join", "group", "order"
]);

const TYPES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "void", "null", "undefined",
  "Promise", "Array", "Record", "Set", "Map", "Object",
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Some", "None",
  "Ok", "Err", "Box", "Rc", "Arc", "int", "float", "dict", "list", "tuple"
]);

const LITERALS = new Set([
  "true", "false", "null", "undefined", "None", "True", "False", "nil"
]);

/**
 * Syntax highlight a single line of code with ANSI color escapes (Candidate #22)
 */
export function highlightLine(line: string, _lang?: string): string {
  // Check for full line comments
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
    return pc.dim(pc.gray(line));
  }

  // Tokenize line into strings, comments, numbers, words, and symbols
  let result = "";
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line[i];

    // Single-line comment from here to end
    if ((ch === "/" && line[i + 1] === "/") || (ch === "#")) {
      result += pc.dim(pc.gray(line.slice(i)));
      break;
    }

    // String literals: "...", '...', `...`
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let str = quote;
      i++;
      while (i < len) {
        const next = line[i];
        str += next;
        if (next === "\\" && i + 1 < len) {
          i++;
          str += line[i];
        } else if (next === quote) {
          i++;
          break;
        }
        i++;
      }
      result += pc.green(str);
      continue;
    }

    // Numbers: integer or floating point
    if (/\d/.test(ch) && (i === 0 || /[\s,([{:;=+\-*/<>]/.test(line[i - 1]))) {
      let num = "";
      while (i < len && /[0-9a-fA-FxX._]/.test(line[i])) {
        num += line[i];
        i++;
      }
      result += pc.magenta(num);
      continue;
    }

    // Identifiers and Keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = "";
      while (i < len && /[a-zA-Z0-9_$]/.test(line[i])) {
        ident += line[i];
        i++;
      }

      const lower = ident.toLowerCase();
      if (KEYWORDS.has(ident) || KEYWORDS.has(lower)) {
        result += pc.bold(pc.cyan(ident));
      } else if (TYPES.has(ident) || /^[A-Z][a-zA-Z0-9_]*$/.test(ident)) {
        result += pc.yellow(ident);
      } else if (LITERALS.has(ident)) {
        result += pc.bold(pc.magenta(ident));
      } else {
        result += ident;
      }
      continue;
    }

    // Operators and delimiters
    if (/[=+\-*/%&|^!~?:<>]/.test(ch)) {
      result += pc.dim(ch);
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Format a multi-line code block with ANSI syntax highlighting and optional line numbers
 */
export function highlightCode(
  code: string,
  lang?: string,
  options: { showLineNumbers?: boolean; startLine?: number } = {}
): string {
  const lines = code.split("\n");
  const showLineNumbers = options.showLineNumbers ?? false;
  const startLine = options.startLine ?? 1;
  const gutterWidth = String(startLine + lines.length).length;

  return lines
    .map((line, idx) => {
      const highlighted = highlightLine(line, lang);
      if (showLineNumbers) {
        const lineNum = String(startLine + idx).padStart(gutterWidth, " ");
        return `${pc.dim(pc.gray(`${lineNum} │`))} ${highlighted}`;
      }
      return highlighted;
    })
    .join("\n");
}

/**
 * Format a unified git diff with ANSI coloring for hunks, additions, deletions, and headers (Candidate #22)
 */
export function highlightDiff(diffText: string): string {
  const lines = diffText.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("index ")) {
      output.push(pc.bold(pc.blue(line)));
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      output.push(pc.bold(pc.cyan(line)));
    } else if (line.startsWith("@@")) {
      output.push(pc.bold(pc.magenta(line)));
    } else if (line.startsWith("+")) {
      output.push(pc.green(line));
    } else if (line.startsWith("-")) {
      output.push(pc.red(line));
    } else {
      output.push(pc.dim(pc.gray(line)));
    }
  }

  return output.join("\n");
}

/**
 * Find and highlight markdown code blocks in text (e.g. from LLM responses or documentation)
 */
export function highlightMarkdownCodeBlocks(text: string): string {
  return text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langLabel = lang ? pc.dim(` [${lang}]`) : "";
    const header = pc.dim(`───${langLabel}───`);
    const footer = pc.dim(`────────────────`);
    const highlighted = highlightCode(code.trimEnd(), lang, { showLineNumbers: true });
    return `\n${header}\n${highlighted}\n${footer}\n`;
  });
}
