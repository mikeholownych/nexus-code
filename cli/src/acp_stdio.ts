/** ACP v1 stdio transport and runtime adapter for Nexus's existing sidecar protocol. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig } from "./types.js";
import { ApplicationCore } from "./core/app.js";
import { formatSafeSidecarDiagnostic, SidecarServer } from "./sidecar.js";
import { PROTOCOL_VERSION, SIDECAR_MAX_HISTORY_PAGES, type SidecarEvent } from "./protocol.js";
import {
  ACP_CANCEL_REQUEST_METHOD, ACP_ERROR, ACP_MAX_INFLIGHT_REQUESTS, ACP_MAX_PENDING_PERMISSIONS_PER_SESSION,
  ACP_MAX_OVERSIZED_LINES, ACP_MAX_SESSIONS, ACP_PERMISSION_TIMEOUT_SECS, ACP_RECEIPT_STORE_SIZE, ACP_TOMBSTONE_COUNT,
  type AcpId, type AcpVerification,
} from "./acp/types.js";
import {
  BoundedLineReader, RequestCorrelator, encodeMessage, errorResponse, notification,
  oversizedLineError, parseMessage, request, resultResponse,
} from "./acp/jsonrpc.js";
import {
  approvalToPermissionRequest, assistantDeltaToUpdate, bindApprovalToToolCall, cancelledRequestError,
  fileDiffToUpdate, historyToReplay, initializeResult, loadSessionResult, newSessionResult, nexusReceipt,
  permissionReplyToCommand, promptResult, sessionUpdate, sidecarErrorToRpc, toolEndToUpdate, toolStartToUpdate,
  turnToStop, verificationFromTurn, verificationUpdate, verdictChunk,
} from "./acp/mapping.js";
import {
  canonicalCwd, validateCancel, validateCancelRequest, validateInitialize, validateLoadSession,
  validateNewSession, validatePrompt, validateReceiptGet,
} from "./acp/validate.js";

type SidecarLike = { start(): void; handleLine(line: string): Promise<void> };
type Session = {
  id: string; cwd: string; mcp: { count: number; names: string[] }; sidecar: SidecarLike;
  events: SidecarEvent[]; tools: SidecarEvent[]; pendingPrompt?: { rpcId: AcpId; commandId: string };
  pendingApproval?: { id: string; rpcId: number; toolCallId: string; timer: NodeJS.Timeout };
  pendingReceipt?: { commandId: string; resolve: (event: SidecarEvent | undefined) => void };
};

export interface AcpStdioOptions {
  config: HarnessConfig;
  version: string;
  write?: (line: string) => void;
  createSidecar?: (config: HarnessConfig, resume: string | undefined, write: (line: string) => void) => SidecarLike;
  realpath?: (value: string) => string;
  isDirectory?: (value: string) => boolean;
}

/** One ACP connection. Every session still executes through ApplicationCore and SidecarServer gates. */
export class AcpStdioServer {
  private readonly write: (line: string) => void;
  private readonly reader = new BoundedLineReader();
  private readonly permissionRequests = new RequestCorrelator<{ sessionId: string; approvalId: string }>({ tombstones: ACP_TOMBSTONE_COUNT });
  private readonly sessions = new Map<string, Session>();
  private readonly receipts = new Map<string, ReturnType<typeof nexusReceipt>>();
  private readonly pending = new Map<string, AcpId>();
  private readonly loadingSessionIds = new Set<string>();
  private startingSessions = 0;
  private initialized = false;
  private closed = false;

  constructor(private readonly options: AcpStdioOptions) {
    this.write = options.write ?? ((line) => process.stdout.write(line));
  }

  /** Feed raw stdin bytes. Invalid/oversized lines are answered without retaining unbounded input. */
  push(chunk: Uint8Array): void {
    if (this.closed) return;
    for (const event of this.reader.push(chunk)) {
      if (this.closed) break;
      if (event.kind === "oversized") {
        this.write(encodeMessage(oversizedLineError()));
        if (this.reader.oversizedLines >= ACP_MAX_OVERSIZED_LINES) void this.close();
      }
      else void this.receive(event.text);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const shutdowns: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.pendingApproval) clearTimeout(session.pendingApproval.timer);
      shutdowns.push(session.sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })));
    }
    this.sessions.clear();
    this.pending.clear();
    await Promise.allSettled(shutdowns);
  }

  private send(message: object): void {
    if (!this.closed) this.write(encodeMessage(message));
  }

  private requestKey(id: AcpId): string { return `${typeof id}:${String(id)}`; }

  private async receive(line: string): Promise<void> {
    const incoming = parseMessage(line);
    if (incoming.kind === "invalid") {
      if (incoming.respond) this.send(errorResponse(incoming.id, incoming.error));
      return;
    }
    if (incoming.kind === "response") {
      const settled = this.permissionRequests.settle(incoming.id);
      if (settled.state !== "matched") return;
      const session = this.sessions.get(settled.context.sessionId);
      if (!session?.pendingApproval || session.pendingApproval.rpcId !== incoming.id) return;
      const pending = session.pendingApproval;
      clearTimeout(pending.timer);
      session.pendingApproval = undefined;
      const command = permissionReplyToCommand(pending.id, incoming);
      await this.sidecarCommand(session, command.type === "approve"
        ? { type: "approve", id: command.id, always: false }
        : { type: "deny", id: command.id });
      return;
    }
    if (this.pending.size >= ACP_MAX_INFLIGHT_REQUESTS && incoming.kind === "request") {
      this.send(errorResponse(incoming.id, { code: ACP_ERROR.INTERNAL_ERROR, message: "too many requests are in flight" }));
      return;
    }
    if (incoming.kind === "request") this.pending.set(this.requestKey(incoming.id), incoming.id);
    try {
      await this.dispatch(incoming);
    } catch (err) {
      if (incoming.kind === "request") this.replyError(incoming.id, { code: ACP_ERROR.INTERNAL_ERROR, message: formatSafeSidecarDiagnostic([err]) });
    } finally {
      const promptStillRunning = incoming.kind === "request" && incoming.method === "session/prompt"
        && [...this.sessions.values()].some((session) => session.pendingPrompt?.rpcId === incoming.id);
      if (incoming.kind === "request" && !promptStillRunning) this.pending.delete(this.requestKey(incoming.id));
    }
  }

  private replyError(id: AcpId, error: { code: number; message: string; data?: unknown }): void {
    this.send(errorResponse(id, error as any));
  }

  private async dispatch(message: Exclude<ReturnType<typeof parseMessage>, { kind: "invalid" | "response" }>): Promise<void> {
    if (message.kind === "request" && !this.initialized && message.method !== "initialize") {
      this.replyError(message.id, { code: ACP_ERROR.INVALID_REQUEST, message: "initialize must be the first request" });
      return;
    }
    if (message.method === "initialize" && message.kind === "request") {
      if (this.initialized) { this.replyError(message.id, { code: ACP_ERROR.INVALID_REQUEST, message: "initialize was already completed" }); return; }
      const parsed = validateInitialize(message.params);
      if (!parsed.ok) { this.replyError(message.id, parsed.error); return; }
      this.initialized = true;
      this.send(resultResponse(message.id, initializeResult({ version: this.options.version, sidecarProtocol: PROTOCOL_VERSION })));
      return;
    }
    if (!this.initialized) return;
    if (message.method === "session/new" && message.kind === "request") return this.newSession(message.id, message.params);
    if (message.method === "session/load" && message.kind === "request") return this.loadSession(message.id, message.params);
    if (message.method === "session/prompt" && message.kind === "request") return this.prompt(message.id, message.params);
    if (message.method === "session/cancel" && message.kind === "notification") {
      const parsed = validateCancel(message.params);
      if (parsed.ok) { const session = this.sessions.get(parsed.value.sessionId); if (session) await this.sidecarCommand(session, { type: "cancel" }); }
      return;
    }
    if (message.method === ACP_CANCEL_REQUEST_METHOD && message.kind === "notification") {
      const parsed = validateCancelRequest(message.params);
      if (parsed.ok) {
        const approval = this.permissionRequests.abandon(parsed.value.requestId as number);
        if (approval) {
          const session = this.sessions.get(approval.sessionId);
          if (session?.pendingApproval?.rpcId === parsed.value.requestId) {
            clearTimeout(session.pendingApproval.timer);
            const approvalId = session.pendingApproval.id;
            session.pendingApproval = undefined;
            await this.sidecarCommand(session, { type: "deny", id: approvalId });
          }
        }
        const id = this.pending.get(this.requestKey(parsed.value.requestId));
        if (id !== undefined) {
          for (const session of this.sessions.values()) if (session.pendingPrompt?.rpcId === id) {
            session.pendingPrompt = undefined;
            await this.sidecarCommand(session, { type: "cancel" });
            this.send(cancelledRequestError(id));
            this.pending.delete(this.requestKey(id));
          }
        }
      }
      return;
    }
    if (message.method === "_nexus/receipt/get" && message.kind === "request") return this.getReceipt(message.id, message.params);
    if (message.kind === "request") this.replyError(message.id, { code: ACP_ERROR.METHOD_NOT_FOUND, message: `method not found: ${message.method}` });
  }

  private canonical(cwd: string): string | undefined {
    const result = canonicalCwd(cwd, {
      realpath: this.options.realpath ?? ((value) => fs.realpathSync(value)),
      isDirectory: this.options.isDirectory ?? ((value) => fs.statSync(value).isDirectory()),
    });
    return result.ok ? result.value : undefined;
  }

  private async startSession(cwd: string, mcp: { count: number; names: string[] }, resume?: string): Promise<Session | undefined> {
    const config = { ...this.options.config, workspace: cwd, surface: "tui" as const };
    const events: SidecarEvent[] = [];
    const early: string[] = [];
    let session: Session;
    const sink = (line: string) => session ? this.onSidecarLine(session, line) : early.push(line);
    const sidecar = this.options.createSidecar?.(config, resume, sink)
      ?? new SidecarServer({ app: new ApplicationCore(config), resume, fullHistoryReplay: resume !== undefined, write: sink });
    session = { id: "", cwd, mcp, sidecar, events, tools: [] };
    try {
      sidecar.start();
    } catch (err) {
      await sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" }));
      throw err;
    }
    for (const line of early) this.onSidecarLine(session, line);
    await new Promise((resolve) => setImmediate(resolve));
    if (this.closed) {
      await sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" }));
      return undefined;
    }
    const state = events.find((event) => event.type === "session.state") as Extract<SidecarEvent, { type: "session.state" }> | undefined;
    if (!state?.session || (resume !== undefined && state.session !== resume)) {
      await sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" }));
      return undefined;
    }
    session.id = state.session;
    return session;
  }

  private async newSession(id: AcpId, params: unknown): Promise<void> {
    const parsed = validateNewSession(params);
    if (!parsed.ok) { this.replyError(id, parsed.error); return; }
    const cwd = this.canonical(parsed.value.cwd);
    if (!cwd) { this.replyError(id, { code: ACP_ERROR.INVALID_PARAMS, message: "cwd does not exist or is not a readable directory" }); return; }
    if (this.sessions.size + this.startingSessions >= ACP_MAX_SESSIONS) { this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "the connection already has the maximum number of sessions" }); return; }
    this.startingSessions++;
    try {
      const session = await this.startSession(cwd, parsed.value.mcpServers);
      if (!session) { if (!this.closed) this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "sidecar did not establish a session" }); return; }
      if (this.sessions.has(session.id)) { await session.sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })); this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "the sidecar generated a duplicate session id" }); return; }
      this.sessions.set(session.id, session);
      const state = session.events.find((event) => event.type === "session.state") as any;
      this.send(resultResponse(id, newSessionResult(state, session.mcp) ?? { sessionId: session.id }));
    } finally {
      this.startingSessions--;
    }
  }

  private async loadSession(id: AcpId, params: unknown): Promise<void> {
    const parsed = validateLoadSession(params);
    if (!parsed.ok) { this.replyError(id, parsed.error); return; }
    const cwd = this.canonical(parsed.value.cwd);
    if (!cwd) { this.replyError(id, { code: ACP_ERROR.INVALID_PARAMS, message: "cwd does not exist or is not a readable directory" }); return; }
    if (this.sessions.has(parsed.value.sessionId) || this.loadingSessionIds.has(parsed.value.sessionId)) { this.replyError(id, { code: ACP_ERROR.INVALID_PARAMS, message: "session is already active on this connection" }); return; }
    if (this.sessions.size + this.startingSessions >= ACP_MAX_SESSIONS) { this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "the connection already has the maximum number of sessions" }); return; }
    this.startingSessions++;
    this.loadingSessionIds.add(parsed.value.sessionId);
    try {
      const session = await this.startSession(cwd, parsed.value.mcpServers, parsed.value.sessionId);
      if (!session) { if (!this.closed) this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "session could not be loaded" }); return; }
      const pages = session.events.filter((event): event is Extract<SidecarEvent, { type: "history" }> => event.type === "history");
      const first = pages[0];
      const valid = Boolean(first && !first.error && Number.isSafeInteger(first.total) && first.total >= 0 &&
        Number.isSafeInteger(first.pages) && first.pages! > 0 && first.pages! <= SIDECAR_MAX_HISTORY_PAGES &&
        pages.length === first.pages && pages.every((page, index) => !page.error && page.session === session.id &&
          page.total === first.total && page.pages === first.pages && page.page === index && Array.isArray(page.messages) &&
          page.messages.every((entry: unknown) => {
            if (!entry || typeof entry !== "object") return false;
            const value = entry as Record<string, unknown>;
            if (typeof value.text !== "string") return false;
            if (["user", "steering", "assistant"].includes(String(value.role))) return true;
            if (value.role === "tool") return (value.tool === undefined || typeof value.tool === "string") &&
              (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
              (value.status === undefined || ["pending", "completed", "failed"].includes(String(value.status)));
            if (value.role === "tool_result") return typeof value.toolCallId === "string" &&
              (value.status === undefined || ["completed", "failed"].includes(String(value.status)));
            return value.role === "outcome" && (value.heading === undefined || typeof value.heading === "string") &&
              (value.text === undefined || typeof value.text === "string");
          })));
      if (!valid || !first) {
        await session.sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" }));
        this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: first?.error ?? "session history is incomplete or invalid; no history was replayed" });
        return;
      }
      const replay = pages.map((page) => historyToReplay(page));
      const extent = { sent: replay.reduce((sum, page) => sum + page.extent.sent, 0), total: first.total };
      if (!Number.isSafeInteger(extent.total) || extent.total < 0 || extent.sent !== extent.total) {
        await session.sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" }));
        this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "session history is incomplete; no history was replayed" });
        return;
      }
      for (const page of replay) for (const update of page.updates) this.send(sessionUpdate(session.id, update));
      this.sessions.set(session.id, session);
      const state = session.events.find((event) => event.type === "session.state") as any;
      this.send(resultResponse(id, loadSessionResult(state, session.mcp, extent)));
    } finally {
      this.startingSessions--;
      this.loadingSessionIds.delete(parsed.value.sessionId);
    }
  }

  private async prompt(id: AcpId, params: unknown): Promise<void> {
    const rawSessionId = (params && typeof params === "object") ? (params as any).sessionId : undefined;
    const session = typeof rawSessionId === "string" ? this.sessions.get(rawSessionId) : undefined;
    if (!session) { this.replyError(id, { code: ACP_ERROR.INVALID_PARAMS, message: "sessionId is not active on this connection" }); return; }
    const parsed = validatePrompt(params, { workspace: session.cwd, fs: { realpath: (value) => fs.realpathSync(value), isDirectory: (value) => fs.statSync(value).isDirectory() } });
    if (!parsed.ok) { this.replyError(id, parsed.error); return; }
    if (session.pendingPrompt) { this.replyError(id, { code: ACP_ERROR.INTERNAL_ERROR, message: "this session already has a prompt in progress" }); return; }
    const commandId = `acp-${String(id).slice(0, 180)}`;
    session.pendingPrompt = { rpcId: id, commandId };
    await this.sidecarCommand(session, { type: "prompt.submit", id: commandId, text: parsed.value.text });
  }

  private async getReceipt(id: AcpId, params: unknown): Promise<void> {
    const parsed = validateReceiptGet(params);
    if (!parsed.ok) { this.replyError(id, parsed.error); return; }
    const receipt = parsed.value.receiptId ? this.receipts.get(parsed.value.receiptId) : [...this.receipts.values()].reverse().find((value) => value.session_id === parsed.value.sessionId);
    if (!receipt || receipt.session_id !== parsed.value.sessionId) { this.replyError(id, { code: ACP_ERROR.INVALID_PARAMS, message: "receipt is not available on this connection" }); return; }
    this.send(resultResponse(id, receipt));
  }

  private async sidecarCommand(session: Session, command: Record<string, unknown>): Promise<void> {
    await session.sidecar.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, ...command }));
  }

  private onSidecarLine(session: Session | undefined, line: string): void {
    if (!session) return;
    let event: SidecarEvent;
    try { event = JSON.parse(line); } catch { return; }
    session.events.push(event);
    if (session.events.length > 2_000) session.events.shift();
    if (event.type === "tool.start") {
      session.tools.push(event);
      this.send(sessionUpdate(session.id, toolStartToUpdate(event as any)));
    } else if (event.type === "assistant.delta") this.send(sessionUpdate(session.id, assistantDeltaToUpdate(event as any)));
    else if (event.type === "file.diff") this.send(sessionUpdate(session.id, fileDiffToUpdate(event as any, session.cwd)));
    else if (event.type === "tool.end") this.send(sessionUpdate(session.id, toolEndToUpdate(event as any)));
    else if (event.type === "approval.request") this.permission(session, event as any);
    else if (event.type === "turn.result") void this.finishPrompt(session, event as any);
    else if (event.type === "error" && session.pendingPrompt && event.id === session.pendingPrompt.commandId) {
      this.replyError(session.pendingPrompt.rpcId, sidecarErrorToRpc(event as any));
      this.pending.delete(this.requestKey(session.pendingPrompt.rpcId));
      session.pendingPrompt = undefined;
    }
    if (session.pendingReceipt && event.type === "receipt" && event.id === session.pendingReceipt.commandId) {
      const pending = session.pendingReceipt; session.pendingReceipt = undefined; pending.resolve(event);
    }
    if (event.type === "session.state" && !session.id && event.session) session.id = event.session;
  }

  private permission(session: Session, event: Extract<SidecarEvent, { type: "approval.request" }>): void {
    if (session.pendingApproval || ACP_MAX_PENDING_PERMISSIONS_PER_SESSION !== 1) {
      void this.sidecarCommand(session, { type: "deny", id: event.id }); return;
    }
    const toolCallId = bindApprovalToToolCall(event as any, session.tools as any);
    const rpcId = this.permissionRequests.open({ sessionId: session.id, approvalId: event.id });
    const timer = setTimeout(() => {
      this.permissionRequests.abandon(rpcId);
      if (session.pendingApproval?.rpcId === rpcId) session.pendingApproval = undefined;
      void this.sidecarCommand(session, { type: "deny", id: event.id });
    }, ACP_PERMISSION_TIMEOUT_SECS * 1000);
    timer.unref?.();
    session.pendingApproval = { id: event.id, rpcId, toolCallId, timer };
    this.send(approvalToPermissionRequest(event as any, { rpcId, sessionId: session.id, toolCallId, workspace: session.cwd }));
  }

  private async finishPrompt(session: Session, event: Extract<SidecarEvent, { type: "turn.result" }>): Promise<void> {
    const pending = session.pendingPrompt;
    if (!pending) return;
    if (session.pendingApproval) {
      clearTimeout(session.pendingApproval.timer); this.permissionRequests.abandon(session.pendingApproval.rpcId); session.pendingApproval = undefined;
    }
    const resultId = `acp-receipt-${pending.commandId}`;
    let sections: any[] = [];
    try {
      const detail = await new Promise<SidecarEvent | undefined>((resolve) => {
        const timer = setTimeout(() => { if (session.pendingReceipt?.commandId === resultId) session.pendingReceipt = undefined; resolve(undefined); }, 2_000);
        session.pendingReceipt = { commandId: resultId, resolve: (value) => { clearTimeout(timer); resolve(value); } };
        void this.sidecarCommand(session, { type: "receipt", id: resultId });
      });
      if (detail?.type === "receipt") sections = detail.sections;
    } catch { /* A missing receipt is represented as missing evidence, never as a passed verifier. */ }
    const turnId = event.turn_id ?? null;
    const verification: AcpVerification = verificationFromTurn({ sessionId: session.id, turnId, turn: event.turn, sections });
    const receipt = nexusReceipt(session.id, verification, sections);
    this.receipts.set(receipt.receipt_id, receipt);
    while (this.receipts.size > ACP_RECEIPT_STORE_SIZE) this.receipts.delete(this.receipts.keys().next().value as string);
    const mapped = turnToStop(event.turn);
    this.send(sessionUpdate(session.id, verificationUpdate(verification) as any));
    this.send(sessionUpdate(session.id, verdictChunk(event.heading, event.line)));
    if ("error" in mapped) this.replyError(pending.rpcId, mapped.error);
    else this.send(resultResponse(pending.rpcId, promptResult(mapped.stopReason, verification)));
    this.pending.delete(this.requestKey(pending.rpcId));
    session.pendingPrompt = undefined;
    session.tools = [];
  }
}

/** Attach the adapter to process stdio. Stdout is reserved for JSON-RPC messages. */
export function runAcpStdio(options: AcpStdioOptions): AcpStdioServer {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  // ACP owns stdout for the lifetime of this command; incidental logs must never corrupt the wire stream.
  (process.stdout as any).write = (_chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(done as () => void);
    return true;
  };
  const server = new AcpStdioServer({ ...options, write: options.write ?? ((line) => protocolWrite(line)) });
  process.stdin.on("data", (chunk: Buffer) => server.push(chunk));
  process.stdin.once("end", () => { void server.close(); });
  process.once("SIGINT", () => { void server.close().then(() => { process.exitCode = 130; }); });
  process.once("SIGTERM", () => { void server.close().then(() => { process.exitCode = 143; }); });
  return server;
}
