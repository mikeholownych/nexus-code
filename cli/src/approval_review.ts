/**
 * What an operator needs to judge a gated tool call, built from the call's arguments. The client renders it
 * (unified diff, command line); the sidecar never decides whether the change is acceptable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./ui.js";

export const MAX_REVIEW_TEXT = 100_000;

export type ApprovalReview =
  | { kind: "change"; path: string; before: string | null; after: string; created: boolean; truncated: boolean }
  | { kind: "patch"; path: string; patch: string; truncated: boolean }
  | { kind: "command"; command: string }
  | { kind: "verifier"; command: string; script?: string; detail?: string }
  | { kind: "args"; text: string; truncated: boolean };

function capped(text: string): { text: string; truncated: boolean } {
  const clean = redactSecrets(text);
  return clean.length > MAX_REVIEW_TEXT ? { text: clean.slice(0, MAX_REVIEW_TEXT), truncated: true } : { text: clean, truncated: false };
}

/**
 * Whether `file` exists, and its text when it is a regular file whose real path stays inside `workspace` and is
 * small enough to show. Symlinks are resolved first, so a link cannot pull outside content into the review.
 */
function currentText(workspace: string, file: string): { exists: boolean; text: string | null } {
  let root: string;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    return { exists: false, text: null };
  }
  const lexical = path.resolve(root, file);
  if (!fs.existsSync(lexical)) return { exists: false, text: null };
  try {
    const target = fs.realpathSync(lexical);
    if (target !== root && !target.startsWith(root + path.sep)) return { exists: true, text: null };
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_REVIEW_TEXT * 4) return { exists: true, text: null };
    return { exists: true, text: fs.readFileSync(target, "utf-8") };
  } catch {
    return { exists: true, text: null };
  }
}

export function approvalReview(tool: string, args: Record<string, any>, workspace: string): ApprovalReview {
  const file = typeof args.path === "string" ? args.path : "";
  switch (tool) {
    case "edit_file": {
      const before = capped(String(args.old_content ?? ""));
      const after = capped(String(args.new_content ?? ""));
      return { kind: "change", path: file, before: before.text, after: after.text, created: false, truncated: before.truncated || after.truncated };
    }
    case "write_file": {
      const current = currentText(workspace, file);
      const before = current.text === null ? null : capped(current.text);
      const after = capped(String(args.content ?? ""));
      return {
        kind: "change",
        path: file,
        before: before ? before.text : null,
        after: after.text,
        created: !current.exists,
        truncated: after.truncated || Boolean(before?.truncated),
      };
    }
    case "patch_file": {
      const patch = capped(String(args.patch ?? ""));
      return { kind: "patch", path: file, patch: patch.text, truncated: patch.truncated };
    }
    case "run_command":
      return { kind: "command", command: redactSecrets(String(args.command ?? "")) };
    case "verifier": {
      const command = redactSecrets(String(args.command ?? ""));
      const script = args.script !== undefined ? capped(String(args.script)).text : undefined;
      const detail = args.detail !== undefined ? redactSecrets(String(args.detail)) : undefined;
      return { kind: "verifier", command, script, detail };
    }
    default: {
      const text = capped(JSON.stringify(args, null, 2));
      return { kind: "args", text: text.text, truncated: text.truncated };
    }
  }
}
