import { execSync } from "node:child_process";

export interface ClipboardResult {
  success: boolean;
  text?: string;
  error?: string;
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

  for (const { cmd } of commands) {
    try {
      execSync(cmd, {
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
