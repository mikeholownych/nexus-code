import { withSkillNoteProvenance } from "./skills.js";

/**
 * Provenance of the user-role messages Nexus writes itself (continuation, recovery, notices, cut-off and empty-reply
 * notes, the skill note). A harness note is recognised by its message-level `harness` marker, never by its text: an
 * operator message that begins with `[Nexus:` is still the operator's request.
 */
export function isHarnessNote(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { role, harness } = message as { role?: unknown; harness?: unknown };
  return role === "user" && (harness === "note" || harness === "skill-note");
}

/**
 * The opening text of each kind of note a v1.1.3 Nexus pushed into the conversation without a marker (the producers in `agent.ts` at v1.1.3). Anchored on the fixed wording (and, where the
 * note has them, its counters), not on the bare `[Nexus` prefix.
 */
const CUT_OFF_HEAD = /^\[Nexus: your previous reply was cut off at /;
const LEGACY_NOTE_HEADS: readonly RegExp[] = [
  /^\[Nexus recovery \d+\/\d+\] You have /,
  /^\[Nexus continuation \d+\/\d+\] The operator's acceptance requirements are still open: /,
  /^\[Nexus: your reply was empty: no text and no tool call\./,
  CUT_OFF_HEAD,
  /^\[Nexus: Malformed native tool call dropped: /,
  /^\[Nexus: Tool "[^"\n]*" is not offered on this request and was not executed\./,
  /^\[Nexus: Tool call "[^"\n]*" rejected: arguments required structural JSON repair /,
  /^\[Nexus\] The output of \S+ has left your context \d+ times through compaction and you re-read it each time\. /,
  /^\[Nexus\] \S+ returned the same result \d+ times on an unchanged workspace/,
];

/**
 * A saved conversation with its harness notes marked. Sessions saved by v1.1.3 hold notes recognisable only by text.
 * A user message without a marker is migrated only when its whole text is a single bracketed Nexus note or starts with
 * one of the exact note openings above, and it is not the first message and does not directly follow an unmarked
 * user message (Nexus writes notes after the model's reply or a tool result, or after another note; only the cut-off
 * note, whose reply is discarded, can directly follow the operator's message). A legacy operator
 * message that copies a note verbatim after a reply is indistinguishable and is migrated: that ambiguity is accepted,
 * because such a message could not be told apart before either. Idempotent: marked messages are left as they are, so
 * a second load changes nothing; text that only contains a note, or begins with `[Nexus:` but not with one of the
 * heads, stays the operator's.
 */
export function withHarnessProvenance<T extends { role: string; content?: unknown; harness?: string }>(messages: readonly T[]): T[] {
  const out = withSkillNoteProvenance(messages);
  for (let i = 1; i < out.length; i++) {
    const message = out[i];
    if (message.role !== "user" || message.harness !== undefined || typeof message.content !== "string") continue;
    const previous = out[i - 1];
    // A cut-off reply is discarded before any assistant message is written, so its note can follow the operator's message.
    const follows = previous.role === "assistant" || previous.role === "tool" || isHarnessNote(previous) || (previous.role === "user" && CUT_OFF_HEAD.test(message.content));
    if (follows && LEGACY_NOTE_HEADS.some((head) => head.test(message.content as string))) out[i] = { ...message, harness: "note" };
  }
  return out;
}
