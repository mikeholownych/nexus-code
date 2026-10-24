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

function fitTerminalText(value: string, maxWidth: number): string {
  if (terminalCellWidth(value) <= maxWidth) return value;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(({ segment }) => segment);
  const suffix: string[] = [];
  let width = 1; // reserve one cell for the leading ellipsis
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const segmentWidth = terminalCellWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    suffix.unshift(segment);
    width += segmentWidth;
  }
  return `…${suffix.join("")}`;
}

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
      const width = Math.max(32, output.columns ?? 80);
      const fit = (value: string) => fitTerminalText(value, width);
      const projectFile = instructionFile ? `Check: ${instructionFile}` : "No project instruction file found";
      const rows = optionsText.map((text, index) => `${choice === index ? "›" : " "} ${text}`);
      output.write([
        "\u001b[2J\u001b[H",
        "Trust this folder?",
        "↑↓ navigate · Enter select · Esc exit",
        fit(displayWorkspace),
        "Load project instructions",
        fit(projectFile),
        "Trust remembered for this folder.",
        "Includes future project config changes.",
        "Trust loads project instructions and",
        "workspace integrations.",
        "Tool approvals use permission settings.",
        "Folder trust doesn't change approvals.",
        ...(statusMessage ? [fit(statusMessage)] : []),
        "",
        ...rows,
      ].join("\n"));
    };

    const finish = (decision: WorkspaceTrustDecision) => {
      if (complete) return;
      complete = true;
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
