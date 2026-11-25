/**
 * PF-3: a unix-socket transport for a running sidecar. Clients other than the parent that holds stdio attach with a
 * token, as one controller or as observers, and detach and attach again at will.
 *
 * Rules, each pinned by cli/test/session_socket.test.ts:
 *  - No command is parsed until the connection's first line has proved the token. A wrong, missing or malformed
 *    attach gets one fixed refusal that says nothing about why, and the connection ends.
 *  - At most one controller. Observers only watch.
 *  - A socket client can drive turns and give one yes or no per approval. It cannot raise the session's authority:
 *    no allow-always, no mode change, no slash command, no provider or model change, no shutdown.
 *  - No TCP, HTTP or WebSocket listener exists here: `listen` takes a filesystem path only.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { BoundedLineReader, type LineEvent } from "./acp/jsonrpc.js";
import { ACP_MAX_LINE_BYTES, ACP_MAX_OVERSIZED_LINES } from "./acp/types.js";
import {
  PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, SIDECAR_CAPABILITIES,
  ProtocolError, encodeEvent, parseCommand, type ErrorCode, type SidecarCommand,
} from "./protocol.js";
import {
  assertPrivateDir, newSocketName, newToken, prepareSocketPath, socketRuntimeDir, sweepStaleSockets, tokenMatches, writeDescriptor,
} from "./core/socket_files.js";

/** Longest line before a connection has attached. An attach line is about 130 bytes. */
export const SOCKET_MAX_PREATTACH_BYTES = 4096;
export const SOCKET_MAX_LINE_BYTES = ACP_MAX_LINE_BYTES;
export const SOCKET_MAX_CONNECTIONS = 8;
/** A connection that has not attached within this long is refused, so idle sockets cannot hold the pre-auth slots. */
export const SOCKET_ATTACH_TIMEOUT_MS = 2000;
/** Connections that have not yet attached; more are told BUSY, so a flood of idle sockets cannot fill all eight. */
export const SOCKET_MAX_PREAUTH = 4;
/** A connection with more than this queued for writing is dropped; a slow observer must not stall the session. */
export const SOCKET_MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

export type SocketRole = "control" | "observe";

/** The one stdout line a sidecar started with `--listen` prints once the socket is bound. It never carries the token. */
export function listeningLine(info: SocketInfo, pid: number = process.pid): string {
  return `${JSON.stringify({ v: PROTOCOL_VERSION, type: "listening", socket: info.socket, descriptor: info.descriptor, pid })}\n`;
}

/** What the hub needs from the sidecar; `SidecarServer` is one. */
export interface SocketSession {
  handleLine(line: string): Promise<void>;
  /** Protocol lines that bring a new client up to date: `hello`, the current `session.state`, a pending `approval.request`. */
  attachSnapshot(): { common: string[]; controller: string[] };
  /**
   * False while the session approves everything (auto mode, or allow-always granted from stdio after start): a socket
   * client may then not start or steer work, because nothing would ask a person before it ran.
   */
  socketMayDriveTurns(): boolean;
}

export interface SessionSocketOptions {
  session: SocketSession;
  /** Directory for the socket and descriptor; default `socketRuntimeDir()`. */
  dir?: string;
  /** File name stem; default a random `s-<16 hex>`. */
  name?: string;
  attachTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export interface SocketInfo {
  socket: string;
  descriptor: string;
}

/**
 * The commands a controller may send over the socket: what it takes to drive a turn and give a person's yes or no to
 * one approval, and to read results. `initialize` is answered by the hub; everything else here is forwarded.
 * Not here, on purpose: `answer` and `checkpoint.choice` (a decision about a requirement or about persisting sensitive
 * content is the owner's, on stdio), `slash`, `shutdown`, `model.*`, `models.list` and `provider.*`.
 */
const CONTROLLER_COMMANDS: ReadonlySet<SidecarCommand["type"]> = new Set([
  "prompt.submit", "steer", "cancel", "approve", "deny", "receipt", "tool.detail",
]);
/** Commands that put work in motion: refused while the session approves everything. */
const WORK_COMMANDS: ReadonlySet<SidecarCommand["type"]> = new Set(["prompt.submit", "steer"]);

/** The one refusal for every failed attach: it must not tell a guesser which part was wrong. */
const REFUSAL = encodeEvent({ type: "error", code: "UNAUTHORIZED", message: "attach refused" });

interface Connection {
  id: string;
  socket: net.Socket;
  reader: BoundedLineReader;
  role?: SocketRole;
  initialized: boolean;
  oversized: number;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class SessionSocketServer {
  private readonly session: SocketSession;
  private readonly server: net.Server;
  private readonly connections = new Set<Connection>();
  private controller?: Connection;
  private token = newToken();
  private socketPath?: string;
  private descriptorPath?: string;
  private socketIdentity?: { dev: number; ino: number };
  private seq = 0;

  constructor(private readonly options: SessionSocketOptions) {
    this.session = options.session;
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => options.onError?.(error));
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async listen(): Promise<SocketInfo> {
    const dir = this.options.dir ?? socketRuntimeDir();
    // The directory is what keeps another user from the socket between bind and chmod, so it is checked for a caller-supplied
    // path as well, before anything is bound in it.
    assertPrivateDir(dir);
    await sweepStaleSockets(dir);
    const name = this.options.name ?? newSocketName();
    const socketPath = path.join(dir, `${name}.sock`);
    const descriptorPath = path.join(dir, `${name}.json`);
    await prepareSocketPath(socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ path: socketPath }, () => { this.server.off("error", reject); resolve(); });
    });
    this.socketPath = socketPath;
    try {
      fs.chmodSync(socketPath, 0o600);
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) throw new Error(`socket ${socketPath} is not mode 0600`);
      this.socketIdentity = { dev: stat.dev, ino: stat.ino };
      this.descriptorPath = descriptorPath;
      writeDescriptor(descriptorPath, { format: "nexus-socket/1", socket: socketPath, token: this.token, pid: process.pid, started_at: new Date().toISOString() });
    } catch (error) {
      await this.close();
      throw error;
    }
    return { socket: socketPath, descriptor: descriptorPath };
  }

  /** Sends one already-formatted protocol line to every attached client. */
  broadcast(line: string): void {
    for (const connection of this.connections) {
      if (connection.role) this.write(connection, line);
    }
  }

  /** Stops listening, drops every client and removes the socket and descriptor. Safe to call more than once and from an exit hook. */
  closeSync(): void {
    for (const connection of [...this.connections]) this.drop(connection);
    try { this.server.close(); } catch { /* not listening */ }
    if (this.socketPath && this.socketIdentity) {
      // Only the socket this server bound: a path someone else put there since is not ours to remove.
      try {
        const stat = fs.lstatSync(this.socketPath);
        if (stat.isSocket() && stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) fs.unlinkSync(this.socketPath);
      } catch { /* already gone */ }
    }
    if (this.descriptorPath) { try { fs.unlinkSync(this.descriptorPath); } catch { /* already gone */ } }
    this.socketPath = this.descriptorPath = this.socketIdentity = undefined;
  }

  async close(): Promise<void> {
    this.closeSync();
    await new Promise<void>((resolve) => (this.server.listening ? this.server.close(() => resolve()) : resolve()));
  }

  // ------------------------------------------------------------------ connections

  private accept(socket: net.Socket): void {
    const attaching = [...this.connections].filter((connection) => !connection.role).length;
    if (this.connections.size >= SOCKET_MAX_CONNECTIONS || attaching >= SOCKET_MAX_PREAUTH) {
      socket.on("error", () => {});
      socket.end(encodeEvent({ type: "error", code: "BUSY", message: "too many connections" }), () => socket.destroy());
      return;
    }
    const connection: Connection = {
      id: `c${++this.seq}`, socket, reader: new BoundedLineReader(SOCKET_MAX_LINE_BYTES), initialized: false, oversized: 0, closed: false,
    };
    this.connections.add(connection);
    connection.timer = setTimeout(() => this.refuse(connection), this.options.attachTimeoutMs ?? SOCKET_ATTACH_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("close", () => this.drop(connection));
    socket.on("error", () => this.drop(connection));
  }

  private drop(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.timer) clearTimeout(connection.timer);
    this.connections.delete(connection);
    // The session keeps running and a pending approval stays pending: the next controller is shown it again.
    if (this.controller === connection) this.controller = undefined;
    connection.socket.destroy();
  }

  /** Sends one last line, then closes. The connection takes no more input meanwhile, and is gone from the hub at once. */
  private finish(connection: Connection, line: string): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.timer) clearTimeout(connection.timer);
    this.connections.delete(connection);
    if (this.controller === connection) this.controller = undefined;
    connection.socket.on("error", () => {});
    connection.socket.end(line, () => connection.socket.destroy());
  }

  private refuse(connection: Connection): void {
    this.finish(connection, REFUSAL);
  }

  private write(connection: Connection, line: string): void {
    if (connection.closed) return;
    if (connection.socket.writableLength > SOCKET_MAX_OUTBOUND_BYTES) {
      this.options.onError?.(new Error(`dropped ${connection.id}: outbound buffer over ${SOCKET_MAX_OUTBOUND_BYTES} bytes`));
      this.drop(connection);
      return;
    }
    connection.socket.write(line);
  }

  private send(connection: Connection, code: ErrorCode, message: string, id?: string): void {
    this.write(connection, encodeEvent({ type: "error", ...(id ? { id } : {}), code, message }));
  }

  private receive(connection: Connection, chunk: Buffer): void {
    if (connection.closed) return;
    const events = connection.reader.push(chunk);
    // Before the attach is proven, nothing larger than an attach line is held, whatever the reader's own cap.
    if (!connection.role && connection.reader.bufferedBytes > SOCKET_MAX_PREATTACH_BYTES) return this.refuse(connection);
    for (const event of events) {
      if (connection.closed) return;
      this.handle(connection, event);
    }
  }

  private handle(connection: Connection, event: LineEvent): void {
    if (!connection.role) {
      if (event.kind !== "line" || Buffer.byteLength(event.text) > SOCKET_MAX_PREATTACH_BYTES) return this.refuse(connection);
      return this.attach(connection, event.text);
    }
    if (event.kind === "oversized") {
      this.send(connection, "BAD_REQUEST", `line is longer than ${SOCKET_MAX_LINE_BYTES} bytes`);
      if (++connection.oversized >= ACP_MAX_OVERSIZED_LINES) this.drop(connection);
      return;
    }
    this.command(connection, event.text);
  }

  // ------------------------------------------------------------------ attach

  private attach(connection: Connection, text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return this.refuse(connection);
      message = parsed;
    } catch {
      return this.refuse(connection);
    }
    const { type, id, token, role } = message;
    // Every check runs and the verdict is one boolean, so which one failed cannot be told from the outside.
    const proven = tokenMatches(this.token, token);
    const wellFormed = type === "attach" && typeof id === "string" && id.length > 0 && id.length <= 128 && (role === "control" || role === "observe") &&
      Number.isInteger(message.v) && (message.v as number) >= PROTOCOL_MIN && (message.v as number) <= PROTOCOL_MAX;
    if (!proven || !wellFormed) return this.refuse(connection);
    if (role === "control" && this.controller) {
      return this.finish(connection, encodeEvent({ type: "error", id: id as string, code: "BUSY", message: "another client controls this session" }));
    }
    if (connection.timer) clearTimeout(connection.timer);
    connection.role = role as SocketRole;
    if (role === "control") this.controller = connection;
    this.write(connection, `${JSON.stringify({ v: PROTOCOL_VERSION, type: "attached", id, connection: connection.id, role })}\n`);
    const snapshot = this.session.attachSnapshot();
    for (const line of snapshot.common) this.write(connection, line);
    if (role === "control") for (const line of snapshot.controller) this.write(connection, line);
  }

  // ------------------------------------------------------------------ commands

  private command(connection: Connection, text: string): void {
    let command: SidecarCommand;
    try {
      command = parseCommand(text);
    } catch (error) {
      this.send(connection, "BAD_REQUEST", (error as Error).message, error instanceof ProtocolError ? error.id : undefined);
      return;
    }
    const id = "id" in command ? command.id : undefined;
    if (command.type === "initialize") return this.initialize(connection, command);
    if (connection.role !== "control") return this.send(connection, "NOT_CONTROLLER", "observers are read-only", id);
    if (!CONTROLLER_COMMANDS.has(command.type)) {
      return this.send(connection, "NOT_PERMITTED", `${command.type} is not available over the socket`, id);
    }
    if (command.type === "approve" && command.always) {
      return this.send(connection, "NOT_PERMITTED", "allow-always is not available over the socket; approve once", command.id);
    }
    if (WORK_COMMANDS.has(command.type) && !this.session.socketMayDriveTurns()) {
      return this.send(connection, "NOT_PERMITTED", "this session approves everything, so it cannot be driven over the socket", id);
    }
    this.session.handleLine(text).catch((error) => this.options.onError?.(error));
  }

  /** Negotiation is per connection and answered here, never forwarded: the sidecar's own state belongs to its stdio parent. */
  private initialize(connection: Connection, command: Extract<SidecarCommand, { type: "initialize" }>): void {
    if (connection.initialized) {
      return this.send(connection, "BAD_REQUEST", "initialize was already answered on this connection; a connection negotiates once.", command.id);
    }
    const min = command.protocol_min ?? PROTOCOL_VERSION;
    const max = command.protocol_max ?? PROTOCOL_VERSION;
    const protocol = Math.min(max, PROTOCOL_MAX);
    if (protocol < Math.max(min, PROTOCOL_MIN)) {
      return this.send(connection, "UNSUPPORTED_PROTOCOL", `No common protocol version: the client speaks ${min} to ${max}, this sidecar speaks ${PROTOCOL_MIN} to ${PROTOCOL_MAX}.`, command.id);
    }
    connection.initialized = true;
    this.write(connection, encodeEvent({ type: "initialized", id: command.id, protocol, capabilities: [...SIDECAR_CAPABILITIES], experimental: [] }));
  }
}
