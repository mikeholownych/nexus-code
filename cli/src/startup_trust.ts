import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getProjectRules } from "./git.js";
import { isWorkspaceTrusted, setWorkspaceTrusted } from "./workspace_trust.js";

export type WorkspaceTrustDecision = "trusted" | "untrusted" | "exit";

export type TrustPromptInput = NodeJS.ReadStream;

export type TrustPromptOutput = NodeJS.WriteStream;

export interface TrustPromptOptions {
  input?: TrustPromptInput;
  output?: TrustPromptOutput;
  trustStore?: {
    isTrusted: (workspace: string) => boolean;
    trust: (workspace: string) => unknown;
  };
}

const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CODEX.md", ".nexusrules"];

function projectInstructionFile(workspace: string): string | undefined {
  return PROJECT_INSTRUCTION_FILES.find((name) => fs.existsSync(path.join(workspace, name)));
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, "�");
}

function codePointCellWidth(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (character === "\u200d" || /[\p{Mark}\p{Format}]/u.test(character)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function terminalCellWidth(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of segmenter.segment(value)) {
    width += Math.max(0, ...[...segment].map(codePointCellWidth));
  }
  return width;
}

/**
 * `tokens` laid out in rows of at most `width` cells, joined by `joiner` (a space for prose, nothing for a path split at
 * its separators). A token wider than a row is split by grapheme, and one grapheme wider than the row stands alone,
 * so every call makes progress at any width.
 */
function wrapTokens(tokens: string[], width: number, joiner: string): string[] {
  const room = Math.max(1, Math.floor(width));
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  const flush = () => {
    if (row) rows.push(row);
    row = "";
    rowWidth = 0;
  };
  for (const token of tokens) {
    if (!token) continue;
    const tokenWidth = terminalCellWidth(token);
    const gap = row ? terminalCellWidth(joiner) : 0;
    if (row && rowWidth + gap + tokenWidth <= room) {
      row += joiner + token;
      rowWidth += gap + tokenWidth;
      continue;
    }
    flush();
    if (tokenWidth <= room) {
      row = token;
      rowWidth = tokenWidth;
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      const segmentWidth = terminalCellWidth(segment);
      if (row && rowWidth + segmentWidth > room) flush();
      row += segment;
      rowWidth += segmentWidth;
    }
  }
  flush();
  return rows;
}

const wrapProse = (text: string, width: number, indent = ""): string[] =>
  wrapTokens(text.split(/\s+/), width - terminalCellWidth(indent), " ").map((row) => indent + row);

/** A path as rows, broken after a separator where it can be, so a directory name is not cut when it need not be. */
const wrapPath = (value: string, width: number): string[] => wrapTokens(value.match(/[^/]*\/?/g) ?? [], width, "");

/** Project instructions are untrusted workspace input and are injected only after the operator explicitly trusts it. */
export function trustedProjectRules(
  workspace: string,
  isTrusted: (workspace: string) => boolean = isWorkspaceTrusted,
): string | null {
  return isTrusted(workspace) ? getProjectRules(workspace) : null;
}

/**
 * Ask for explicit trust before starting an interactive Nexus client. Non-interactive launches continue under the
 * existing untrusted-workspace policy and never persist trust implicitly.
 */
export function promptWorkspaceTrust(
  workspace: string,
  options: TrustPromptOptions = {},
): Promise<WorkspaceTrustDecision> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const noticeOutput = options.output ?? process.stderr;
  const trustStore = options.trustStore ?? {
    isTrusted: isWorkspaceTrusted,
    trust: (target: string) => setWorkspaceTrusted(target, true),
  };
  const resolvedWorkspace = path.resolve(workspace);
  const displayWorkspace = safeTerminalText(resolvedWorkspace);

  if (trustStore.isTrusted(resolvedWorkspace)) return Promise.resolve("trusted");
  if (!input.isTTY || !output.isTTY) {
    noticeOutput.write(
      `Nexus: ${displayWorkspace} is not trusted. Project instructions and workspace integrations stay unloaded. ` +
      `Run 'nexus trust .' to load them. Tool approvals follow your permission settings.\n`,
    );
    return Promise.resolve("untrusted");
  }

  const instructionFile = projectInstructionFile(resolvedWorkspace);
  const optionsText = [
    "Trust and continue",
    "Continue without trusting",
    "Exit",
  ];
  const selected = 0;
  const oldRawMode = Boolean(input.isRaw);

  return new Promise((resolve) => {
    let choice = selected;
    let complete = false;
    let statusMessage: string | undefined;

    const render = () => {
      // A pty opened without a window size reports 0 columns (not undefined): that is an unknown width, drawn at 80.
      const width = Number.isFinite(output.columns) && (output.columns as number) > 0 ? Math.floor(output.columns as number) : 80;
      const rows = optionsText.flatMap((text, index) =>
        wrapProse(text, width - 2).map((row, line) => `${line === 0 ? (choice === index ? "›" : " ") : " "} ${row}`));
      const instructions = instructionFile
        ? wrapProse(`Project instructions found: ${instructionFile}`, width)
        : wrapProse("No project instruction file found in this folder.", width);
      output.write([
        "\u001b[2J\u001b[H",
        ...wrapProse("Trust this folder?", width),
        "",
        ...wrapPath(displayWorkspace, width),
        "",
        ...instructions,
        "",
        ...wrapProse(
          "Trusting this folder lets Nexus load its project instructions and workspace integrations, including any that change later. Trusting is remembered for this folder; the other choices ask again next time.",
          width,
        ),
        "",
        ...wrapProse("Trust does not change tool approvals; those follow your permission settings.", width),
        ...(statusMessage ? ["", ...wrapProse(statusMessage, width)] : []),
        "",
        ...rows,
        "",
        ...wrapProse("↑↓ move · Enter select · Esc exit", width),
      ].join("\n"));
    };

    const finish = (decision: WorkspaceTrustDecision) => {
      if (complete) return;
      complete = true;
      output.removeListener("resize", render);
      input.removeListener("keypress", onKeypress);
      input.removeListener("close", onClose);
      try { input.setRawMode(oldRawMode); } catch {}
      if (decision === "exit") {
        try { input.pause(); } catch {}
      }
      output.write("\u001b[?25h\n");
      resolve(decision);
    };

    const onClose = () => finish("exit");
    const onKeypress = (_character: string | undefined, key: readline.Key) => {
      if (key?.ctrl && key.name === "c") return finish("exit");
      if (key?.name === "escape") return finish("exit");
      if (key?.name === "up") {
        choice = (choice + optionsText.length - 1) % optionsText.length;
        render();
        return;
      }
      if (key?.name === "down") {
        choice = (choice + 1) % optionsText.length;
        render();
        return;
      }
      if (key?.name !== "return" && key?.name !== "enter") return;
      if (choice === 0) {
        try {
          trustStore.trust(resolvedWorkspace);
          finish("trusted");
        } catch (error) {
          statusMessage = `Trust was not saved: ${safeTerminalText(String((error as Error)?.message ?? error))}`;
          render();
        }
      } else if (choice === 1) {
        finish("untrusted");
      } else {
        finish("exit");
      }
    };

    readline.emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    input.once("close", onClose);
    output.on("resize", render);
    try {
      input.setRawMode(true);
      input.resume();
      output.write("\u001b[?25l");
      render();
    } catch {
      finish("exit");
      output.write(`Nexus: could not open the trust prompt. Run 'nexus trust .' or restart in an interactive terminal.\n`);
    }
  });
}
