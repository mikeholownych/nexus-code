/**
 * Typed messages between units (and from the operator), stored in the operation record.
 *
 * Concurrency forbids shared mutable memory: a unit may not read another unit's in-flight workspace, and a summary
 * is not accessible just because it exists. Everything that crosses a unit boundary does so as a persisted message
 * with a sender, a recipient, a kind and a delivery record. A message is advisory context, never verification
 * evidence: it cannot change a TurnResult, satisfy a verifier, or substitute for an independence check.
 *
 * Delivery is at most once. The runner marks a message delivered in the same save that records the unit's RUNNING
 * transition, so a crash either delivers it with the transition or not at all.
 */
import type { DurableOperationState, OperationMessage, OperationMessageKind } from "./operation.js";

/** Messages retained per operation. Old delivered messages are dropped first; the record stays bounded. */
export const MAX_MESSAGES = 200;
/** Messages delivered to one turn. A unit's start prompt must stay small and predictable. */
export const MAX_MESSAGES_PER_TURN = 20;
/** A message body is short by design: it carries a summary and pointers, not content. */
export const MAX_MESSAGE_BODY = 4_000;

const KINDS: ReadonlySet<string> = new Set(["request", "observation", "artifact", "verdict"]);
const REF_KINDS: ReadonlySet<string> = new Set(["file", "receipt", "unit", "checkpoint"]);
// C0 (except TAB/LF), CR, DEL, C1: rejected at write time rather than stripped, so the sender learns the body was
// unsafe instead of silently handing the recipient something different from what it sent. CR is rejected because a
// message body is rendered line-oriented in a prompt and in a terminal.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f-\u009f]/;

/** A message the operation will not store. */
export class MessageRejected extends Error {}

export interface MessageInput {
  from: string;
  /** A unit id, or `*` for the operation. */
  to: string;
  kind: OperationMessageKind;
  body: string;
  refs?: OperationMessage["refs"];
}

export interface PublishResult {
  message: OperationMessage;
  /** Messages dropped to stay within `MAX_MESSAGES`; the caller reports them as an event. */
  dropped: OperationMessage[];
}

/**
 * The next id. It comes from a durable counter, not from the surviving messages: a pruned message's id is cited by
 * `OPERATION_MESSAGE` events, so reusing it would make two different messages share an id in the timeline.
 */
function nextId(state: DurableOperationState): string {
  let highest = state.messageSeq ?? 0;
  for (const message of state.messages ?? []) {
    const match = /^msg-(\d+)$/.exec(message.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const next = highest + 1;
  state.messageSeq = next;
  return `msg-${next}`;
}

/**
 * Validates and appends one message. `to` must name a unit of this operation or be `*`; a body must be non-empty,
 * within bounds and free of control characters. The caller persists the state.
 */
export function publishMessage(state: DurableOperationState, input: MessageInput, now: number): PublishResult {
  const from = input.from.trim();
  const to = input.to.trim();
  if (!from) throw new MessageRejected("a message needs a sender");
  if (!to) throw new MessageRejected("a message needs a recipient ('*' for the whole operation)");
  if (to !== "*" && !state.units.some((unit) => unit.id === to)) {
    throw new MessageRejected(`no work unit '${to}' in this operation (recipients: ${state.units.map((u) => u.id).join(", ")})`);
  }
  if (!KINDS.has(input.kind)) throw new MessageRejected(`unknown message kind '${String(input.kind)}' (known: ${[...KINDS].join(", ")})`);
  const body = input.body.trim();
  if (!body) throw new MessageRejected("a message needs a non-empty body");
  if (body.length > MAX_MESSAGE_BODY) throw new MessageRejected(`a message body is limited to ${MAX_MESSAGE_BODY} characters (got ${body.length})`);
  if (UNSAFE.test(body) || UNSAFE.test(from) || UNSAFE.test(to)) throw new MessageRejected("a message may not contain control characters");
  for (const ref of input.refs ?? []) {
    if (!REF_KINDS.has(ref.kind)) throw new MessageRejected(`unknown reference kind '${String(ref.kind)}' (known: ${[...REF_KINDS].join(", ")})`);
    if (!ref.ref) throw new MessageRejected("a message reference needs a value");
    if (UNSAFE.test(ref.ref)) throw new MessageRejected("a message reference may not contain control characters");
  }

  const message: OperationMessage = {
    id: nextId(state),
    at: new Date(now).toISOString(),
    from,
    to,
    kind: input.kind,
    body,
    ...(input.refs?.length ? { refs: input.refs } : {}),
  };
  const all = [...(state.messages ?? []), message];
  const dropped: OperationMessage[] = [];
  while (all.length > MAX_MESSAGES) {
    // Drop a delivered message before an undelivered one: an undelivered message is still owed to a unit.
    // Prefer a message no unit is owed any more; otherwise the oldest that has at least been seen once.
    const index = all.findIndex((candidate) => candidate.deliveredAt !== undefined);
    const [removed] = all.splice(index >= 0 ? index : 0, 1);
    dropped.push(removed);
  }
  state.messages = all;
  return { message, dropped };
}

/**
 * Messages owed to `unitId`: addressed to it or to the operation, not from itself, not already received by it, oldest
 * first, bounded per turn. `to: "*"` means each unit receives it once — not that the first unit consumes it.
 */
export function undeliveredFor(state: DurableOperationState, unitId: string): OperationMessage[] {
  return (state.messages ?? [])
    .filter(
      (message) =>
        !message.deliveredTo?.includes(unitId) && message.from !== unitId && (message.to === unitId || message.to === "*"),
    )
    .slice(0, MAX_MESSAGES_PER_TURN);
}

/** Records delivery. Called in the same save that starts the unit, so a crash cannot deliver twice. */
export function markDelivered(state: DurableOperationState, ids: string[], unitId: string, at: string): void {
  const wanted = new Set(ids);
  for (const message of state.messages ?? []) {
    if (!wanted.has(message.id)) continue;
    const to = message.deliveredTo ?? [];
    if (to.includes(unitId)) continue;
    message.deliveredTo = [...to, unitId];
    message.deliveredAt ??= at;
  }
}

/**
 * The prompt fragment for an undelivered set. Messages are advisory context, so the heading says where they came from
 * and nothing more; the recipient must still read what it relies on.
 */
export function messagesBlock(messages: OperationMessage[] | undefined): string {
  if (!messages?.length) return "";
  const lines = messages.map((message) => {
    const refs = message.refs?.length ? ` (${message.refs.map((ref) => `${ref.kind}: ${ref.ref}`).join("; ")})` : "";
    return `- [${message.kind}] ${message.from}: ${message.body}${refs}`;
  });
  return `\nMessages from other units (advisory; read the referenced artifact before relying on it):\n${lines.join("\n")}\n`;
}
