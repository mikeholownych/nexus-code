import { createHash } from "node:crypto";

/**
 * VC-9: a headless run that needs an operator decision ends BLOCKED with reason NEEDS_INPUT and one of these, and
 * resumes with `nexus run --resume <task> --answer <id>=<option>`.
 *
 * The id is a digest of what is being decided, so the same decision gets the same id when the resumed run reaches it
 * again, and an answer for one decision never approves another (a different tool, argument or verifier script has a
 * different id).
 */
export type NeedsInputKind = "tool_approval" | "verifier_approval" | "verification_edit" | "blocked_requirement" | "steering_conflict";

export type NeedsInputOption = "approve" | "decline";

/** A question that is not a yes/no: the operator answers in their own words (`--answer <id>=reply:<text>`). */
export type NeedsInputReplyOption = "reply";

export interface NeedsInputQuestion {
  id: string;
  kind: NeedsInputKind;
  /** One sentence the operator can answer. */
  prompt: string;
  /** What is being decided, as short strings (never secrets: arguments are clipped and redacted by the caller). */
  subject: Record<string, string>;
  options: Array<{ id: NeedsInputOption | NeedsInputReplyOption; label: string }>;
  /** Present when a delegated subagent raised the question: how deep it ran and what it was asked to do. The id is unchanged, so `--answer` works as for any other question. */
  subagent?: { depth: number; objective: string };
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

/** The longest reply taken from the command line; a longer one is refused rather than cut silently. */
export const MAX_REPLY_CHARS = 2000;

/**
 * VC-9 row 8: the model marked an operator requirement blocked. There is nothing to approve: the operator has to say what
 * to do about the blocker, so the only option is a free-text reply. The id binds the requirement and the stated reason,
 * so a reply to one blocker is never taken as the reply to another (or to the same requirement blocked for a new reason).
 */
export function buildBlockedRequirementQuestion(requirement: { id: string; text: string; note?: string }): NeedsInputQuestion {
  const reason = (requirement.note ?? "").trim() || "no reason was recorded";
  return {
    id: needsInputId("blocked_requirement", requirement.id, reason),
    kind: "blocked_requirement",
    prompt: `Requirement ${requirement.id} is blocked: ${reason.slice(0, 200)}. What should the run do about it?`,
    subject: { requirement: requirement.id, text: requirement.text.slice(0, 200), blocker: reason.slice(0, 300) },
    options: [{ id: "reply", label: "Say what to do about the blocker, in your own words" }],
  };
}

/**
 * VC-9 row 7: steering that would drop a requirement needed the operator's decision and the turn ended without one
 * (nobody could be asked, or the turn closed first). The steering was not applied and the ledger is unchanged. Approving
 * applies it (the named requirements are descoped as accepted); declining keeps them. The id binds the steering message.
 */
export function buildSteeringConflictQuestion(conflict: { id: string; text: string; requirements: readonly string[] }, safeText: (text: string, max?: number) => string): NeedsInputQuestion {
  const negates = conflict.requirements.join(", ");
  return {
    id: needsInputId("steering_conflict", conflict.id, conflict.text),
    kind: "steering_conflict",
    prompt: `Steering received during the turn would drop ${negates} and was not applied because no decision was given. Apply it?`,
    subject: { steering: conflict.id, text: safeText(conflict.text, 300), negates },
    options: [
      { id: "approve", label: `Apply the steering: ${negates} dropped (descoped, accepted by you)` },
      { id: "decline", label: "Keep the requirements; the steering is not applied" },
    ],
  };
}

export interface OperatorAnswers {
  /** `id=approve|decline`: bound to a decision by id, consumed when the run reaches it. */
  decisions: Map<string, NeedsInputOption>;
  /** `id=reply:<text>`: the operator's words for a question that is not a yes/no. */
  replies: Map<string, string>;
}

/** Every `--answer` pair from the command line, decisions and replies; throws a message naming the bad pair. */
export function parseOperatorAnswers(pairs: readonly string[]): OperatorAnswers {
  const answers: OperatorAnswers = { decisions: new Map(), replies: new Map() };
  for (const pair of pairs) {
    const reply = /^\s*([0-9a-f]{12})=reply:([\s\S]*)$/.exec(pair);
    if (reply) {
      const text = reply[2].trim();
      if (!text) throw new Error(`--answer ${reply[1]}=reply: needs the reply text after 'reply:'`);
      if (text.length > MAX_REPLY_CHARS) throw new Error(`--answer ${reply[1]}=reply: is ${text.length} characters; the limit is ${MAX_REPLY_CHARS}`);
      answers.replies.set(reply[1], text);
      continue;
    }
    const m = /^([0-9a-f]{12})=(approve|decline)$/.exec(pair.trim());
    if (!m) throw new Error(`--answer expects <question id>=approve|decline, or <question id>=reply:<text> for a question that asks for a reply (the id is the 12-character needsInput.id from the blocked result), got '${pair.slice(0, 60)}'`);
    answers.decisions.set(m[1], m[2] as NeedsInputOption);
  }
  return answers;
}

/**
 * What the resumed run tells the model about the operator's replies. The reply is the operator's instruction for that
 * blocker; the requirement is still recorded as blocked, so the model is told to reopen it before acting.
 */
export function replyNote(replies: ReadonlyMap<string, string>): string {
  const lines = [...replies].map(([id, text]) => `question ${id}: the operator replied: ${JSON.stringify(text)}`);
  return `The operator replied to the blocker(s) the previous run stopped on:\n${lines.join("\n")}\nFor each one: if the reply lets the work proceed, set that requirement back to in_progress with update_requirements and do it; if the reply takes it out of scope, record it as descoped with the operator's reply as the note. Do not leave it blocked for the same reason.`;
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
