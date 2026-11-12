import { execFileSync, execSync } from "node:child_process";

export interface ClipboardResult {
  success: boolean;
  text?: string;
  error?: string;
  /** Set by `copyWithFallback` when no tool took the text: it is to be written to the terminal as an OSC 52 request. */
  osc52?: string;
}

/**
 * Longest text an OSC 52 request carries: xterm and most terminals accept 100000 base64 characters, which is 74994
 * bytes. A longer text is refused, never cut, so a partial copy cannot pass for a whole one.
 */
export const OSC52_MAX_BYTES = 74_994;

/** `NEXUS_OSC52=off` (also `0`, `false`, `no`, `none`) turns the fallback off. */
export function osc52Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["off", "0", "false", "no", "none"].includes((env.NEXUS_OSC52 ?? "").trim().toLowerCase());
}

/**
 * The terminal request for a clipboard write: `ESC ] 52 ; c ; <base64> BEL`. The text enters it only as base64, whose
 * alphabet holds no control character, so text a model wrote cannot end the sequence or start another.
 */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** Copies with a clipboard tool, else (SSH, tmux, a headless box) asks the terminal to do it through OSC 52. */
export function copyWithFallback(text: string, env: Record<string, string | undefined> = process.env): ClipboardResult {
  const viaTool = copyToClipboard(text);
  if (viaTool.success) return viaTool;
  if (!osc52Enabled(env)) {
    return { success: false, error: `${viaTool.error} Terminal clipboard (OSC 52) is off: NEXUS_OSC52=off.` };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) return { success: false, error: `${viaTool.error} There is nothing to copy.` };
  if (bytes > OSC52_MAX_BYTES) {
    return {
      success: false,
      error: `${viaTool.error} The text is ${bytes} bytes; the terminal clipboard (OSC 52) takes at most ${OSC52_MAX_BYTES}. Try /copy code, or install a clipboard tool.`,
    };
  }
  return { success: true, text, osc52: text };
}

/**
 * Copy text to system clipboard (Candidate #24)
 * Supports Wayland (wl-copy), X11 (xclip/xsel), and macOS (pbcopy)
 */
export function copyToClipboard(text: string): ClipboardResult {
  const commands = [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
    { cmd: "pbcopy", args: [] },
  ];

  for (const { cmd, args } of commands) {
    try {
      execFileSync(cmd, args, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 3000,
      });
      return { success: true, text };
    } catch {
      // Try next clipboard command
    }
  }

  return {
    success: false,
    error: "No supported clipboard tool found (install wl-copy, xclip, or xsel).",
  };
}

/**
 * Read text from system clipboard (Candidate #24)
 */
export function readFromClipboard(): ClipboardResult {
  const commands = [
    "wl-paste",
    "xclip -selection clipboard -o",
    "xsel --clipboard --output",
    "pbpaste",
  ];

  for (const cmd of commands) {
    try {
      const output = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return { success: true, text: output };
    } catch {
      // Try next clipboard command
    }
  }

  return {
    success: false,
    error: "No supported clipboard tool found (install wl-paste, xclip, or xsel).",
  };
}
