import { createHash } from "node:crypto";

/**
 * VC-9: a headless run that needs an operator decision ends BLOCKED with reason NEEDS_INPUT and one of these, and
 * resumes with `nexus run --resume <task> --answer <id>=<option>`.
 *
 * The id is a digest of what is being decided, so the same decision gets the same id when the resumed run reaches it
 * again, and an answer for one decision never approves another (a different tool, argument or verifier script has a
 * different id).
 */
export type NeedsInputKind = "tool_approval" | "verifier_approval" | "verification_edit";

export type NeedsInputOption = "approve" | "decline";

export interface NeedsInputQuestion {
  id: string;
  kind: NeedsInputKind;
  /** One sentence the operator can answer. */
  prompt: string;
  /** What is being decided, as short strings (never secrets: arguments are clipped and redacted by the caller). */
  subject: Record<string, string>;
  options: Array<{ id: NeedsInputOption; label: string }>;
}

export const NEEDS_INPUT_OPTIONS: ReadonlyArray<{ id: NeedsInputOption; label: string }> = [
  { id: "approve", label: "Approve this one action and continue" },
  { id: "decline", label: "Decline it; the run will not ask again for this action" },
];

export function needsInputId(kind: NeedsInputKind, ...parts: string[]): string {
  return createHash("sha256").update([kind, ...parts].join("\n")).digest("hex").slice(0, 12);
}

export function buildNeedsInput(kind: NeedsInputKind, prompt: string, subject: Record<string, string>, ...idParts: string[]): NeedsInputQuestion {
  return { id: needsInputId(kind, ...idParts), kind, prompt, subject, options: NEEDS_INPUT_OPTIONS.map((o) => ({ ...o })) };
}

/** `id=approve` pairs from the command line; throws a message naming the bad pair. */
export function parseAnswers(pairs: readonly string[]): Map<string, NeedsInputOption> {
  const answers = new Map<string, NeedsInputOption>();
  for (const pair of pairs) {
    const m = /^([0-9a-f]{12})=(approve|decline)$/.exec(pair.trim());
    if (!m) throw new Error(`--answer expects <question id>=approve|decline (the id is the 12-character needsInput.id from the blocked result), got '${pair.slice(0, 60)}'`);
    answers.set(m[1], m[2] as NeedsInputOption);
  }
  return answers;
}

/** What the resumed run tells the model, so it re-issues the blocked action instead of choosing another route. */
export function answerNote(answers: ReadonlyMap<string, NeedsInputOption>): string {
  const lines = [...answers].map(([id, answer]) => `question ${id}: ${answer === "approve" ? "APPROVED. Re-issue exactly that action now (same tool, same arguments)." : "DECLINED. Do not attempt that action again; continue without it or report what remains."}`);
  return `The operator answered the question(s) the previous run was blocked on:\n${lines.join("\n")}`;
}
