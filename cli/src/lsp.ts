import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildMcpEnvironment } from "./mcp.js";

const LSP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const EDIT_DIAGNOSTICS_GRACE_MS = 8_000;
const LSP_TOOLCHAIN_VARS = ["RUSTUP_HOME", "CARGO_HOME", "RUSTUP_TOOLCHAIN", "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE"];
/**
 * Documents one server keeps open; the least recently queried one beyond this is closed (`didClose`), which hands that
 * file back to the server's own reading of the disk. Every query re-checks every open document (one realpath and one
 * stat each), and a server re-analyses its open documents on each change, so the set is kept to what an agent works on
 * at one time (an editor's worth of tabs), not every file it ever asked about.
 */
export const MAX_OPEN_DOCUMENTS = 32;
/**
 * A file's stat is taken as proof that it has not changed only when its newest timestamp was at least this old when the
 * file was read. Timestamps come from a clock that advances in steps (a kernel tick, or 1 to 2 s on coarse file systems):
 * a second write inside the step of the first leaves them equal, so a file changed that recently is compared by content.
 */
export const STAT_SETTLE_MS = 2_000;
/**
 * Push-only servers: how long the server must have published nothing before a list that predates a change to another
 * document is taken as still standing (see `settledAt`). It has to outlast the gap between a server's publish for the
 * changed file and its publish for a dependent one; servers batch or debounce those within a few hundred milliseconds,
 * and 1 s is several times that. Longer would make every such query slower by as much; shorter would return more old
 * lists from a server that is slow to reach the dependent file. Counted from the last publish, so a query made a moment
 * after an edit usually finds most of it already spent.
 */
export const PUBLISH_QUIET_MS = 1_000;
/** A staged server's progress must have been over for this long before its lists are taken as settled. */
const QUIET_MS = 1500;
/** LSP `ServerCancelled`: the server abandoned a pull request; its data says whether to ask again. */
const SERVER_CANCELLED = -32802;
/** How often one diagnostics query asks again after such a cancellation (within its timeout). */
const PULL_RETRIGGER_LIMIT = 3;
/** Wakes a query waiting for evidence that the server has settled: any publish, the end of a progress cycle, a close. */
const ANY_DOCUMENT = "";

export type DiagnosticsAnswer = { status: "ok"; diagnostics: LspDiagnostic[] } | { status: "unavailable"; reason: string };

const toDiagnostics = (items: any[]): LspDiagnostic[] =>
  items.map((d: any) => ({
    range: d.range,
    severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "information",
    message: d.message,
    source: d.source,
    ...(d.code !== undefined && d.code !== null ? { code: d.code } : {}),
  }));

const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The containment rule for documents; `child` and `root` are real paths. */
const outsideRoot = (root: string, child: string): boolean => {
  const rel = path.relative(root, child);
  return rel.startsWith("..") || path.isAbsolute(rel);
};

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

/**
 * The environment a language server starts with: the MCP allowlist (no credentials) plus the toolchain locations the
 * servers need. PATH keeps only existing absolute entries that do not resolve (through symlinks) into the workspace, so
 * project content cannot supply the binary. When the workspace is a home directory or a system prefix that itself
 * contains the toolchain, its entries are kept: dropping them would leave no server installed.
 */
export function buildLspEnvironment(workspace: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildMcpEnvironment();
  for (const k of LSP_TOOLCHAIN_VARS) if (source[k] !== undefined) env[k] = source[k]!;
  for (const [k, v] of Object.entries(env)) {
    if (/^(https?|all)_proxy$/i.test(k) && /\/\/[^/]*@/.test(v)) delete env[k];
  }
  const root = realOrNull(path.resolve(workspace));
  const broad =
    root !== null &&
    [os.homedir(), ...SYSTEM_BIN_DIRS].some((d) => {
      const real = realOrNull(d);
      return real !== null && isInside(root, real);
    });
  env.PATH = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => {
      if (!path.isAbsolute(d) || root === null) return false;
      const real = realOrNull(d);
      return real !== null && (broad || !isInside(root, real));
    })
    .join(path.delimiter);
  return env;
}

/** Thrown by a query whose file cannot be given to the server; the message is the answer the caller reports. */
const unreadable = (filePath: string): Error => new Error(`${filePath} is not a readable file inside the workspace.`);

/** One spelling per path for comparisons: no trailing separator, no `.` or `..`, a lower-case drive letter. */
const comparablePath = (p: string): string => path.resolve(p).replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

interface FileState {
  text: string;
  /** Device, inode, size, mtime and ctime (ns). ctime is included because an edit can restore size and mtime but not it. */
  stamp: string;
  /** The stamp alone proves "unchanged" (see STAT_SETTLE_MS); otherwise the next check compares content. */
  settled: boolean;
}

function stampOf(st: fs.BigIntStats, readAtMs: number): Pick<FileState, "stamp" | "settled"> {
  const newest = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
  return {
    stamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`,
    settled: BigInt(readAtMs) * 1_000_000n - newest >= BigInt(STAT_SETTLE_MS) * 1_000_000n,
  };
}

/**
 * The regular file at `real` (a path already resolved through symlinks), or null. The descriptor refuses a symlink put in
 * the last component since the path was resolved, and does not block on a FIFO; the stamp is of the file actually read.
 */
function readRegularFile(real: string): FileState | null {
  let fd: number | undefined;
  try {
    const readAtMs = Date.now();
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    return { text: fs.readFileSync(fd, "utf-8"), ...stampOf(st, readAtMs) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What the server holds for one file. The client's only record of it: every query goes through `LspClient.open`. */
interface OpenDocument extends FileState {
  /** Identity: the file's real path. Two spellings of one file (a symlink, a symlinked workspace) are one document. */
  key: string;
  /** The spelling sent to the server, and the paths a server may name it by (as sent, and canonical). */
  uri: string;
  paths: string[];
  /** The version sent with the latest didOpen or didChange. */
  version: number;
  /** The sequence number of the latest didChange for it; 0 while it is as it was opened. */
  changedSeq: number;
  /** The latest list published for this version, and the client sequence number when it arrived. */
  diagnostics?: { list: LspDiagnostic[]; seq: number };
  /** The last full report pulled for it, kept so that an "unchanged" reply to its `resultId` has a list to stand for. */
  pulled?: { list: LspDiagnostic[]; resultId?: string };
  /** Diagnostics queries waiting on this document; it is not evicted meanwhile. */
  waiting: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspServerSpec {
  cmd: string;
  args?: string[];
  languageId: string;
  /** Extra variables for this server only; the built-in table never sets it. */
  env?: Record<string, string>;
  /**
   * The server analyses in stages and publishes an empty list before it has finished (rust-analyzer: before the Cargo
   * project is loaded and types are analysed). Diagnostics then wait, within the caller's timeout, until the server's own
   * progress reports (`$/progress`) have ended, instead of returning on the first publish.
   */
  awaitProgress?: boolean;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

/**
 * Lightweight Language Server Protocol Client (Candidate #44)
 * Communicates with rust-analyzer, typescript-language-server, pyright via JSON-RPC stdio
 */
export class LspClient {
  public serverCmd: string;
  public serverArgs: string[];
  public rootPath: string;
  /** Open documents by identity (real path), least recently queried first. */
  private documents: Map<string, OpenDocument> = new Map();
  /** The same documents by the URI sent to the server. */
  private opened: Map<string, OpenDocument> = new Map();
  /**
   * One counter orders everything the client tells the server about content: it supplies each document version (so a
   * version is never reused, also not by a document closed and opened again) and stamps each list on arrival.
   * `lastChangeSeq` is its value at the latest change of content the server holds: a didChange, or the close of a document
   * whose file is gone. A list that arrived before it was computed without that change.
   */
  private seq = 0;
  private lastChangeSeq = 0;
  /** The latest change no publish can vouch for any more: its document was closed (deleted, or evicted) before the server published for it. */
  private unevidencedSeq = 0;
  /** When the server last published diagnostics for any file, and whether it has ever attached a version. */
  private lastPublishAt = 0;
  private versionedPublishes = false;
  /**
   * Set when the server offers pull diagnostics (`diagnosticProvider`): a diagnostics query is then a
   * `textDocument/diagnostic` request, answered for the content the server holds, and published lists are not consulted.
   * `interFileDependencies` and `workspaceDiagnostics` are recorded as announced; workspace diagnostics are not used.
   */
  public diagnosticProvider: { identifier?: string; interFileDependencies: boolean; workspaceDiagnostics: boolean } | null = null;
  private diagnosticWaiters: Map<string, Array<() => void>> = new Map();
  private child: ChildProcess | null = null;
  private nextId: number = 1;
  private pending: Map<number, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private documentChangedAt: Map<string, number> = new Map();
  private saveOptions?: { includeText?: boolean };
  private buffer: Buffer = Buffer.alloc(0);
  public initialized: boolean = false;
  /** Tokens of the server's work-done progress that has begun and not ended (with the sequence number at their begin), and when progress last changed. */
  private progressActive: Map<string, number> = new Map();
  /** The highest sequence number at which a progress cycle that has since ended began: the server finished work it started after every change up to it. */
  private progressSettledSeq = 0;
  private progressSeen = false;
  private lastProgressAt = 0;

  constructor(serverCmd: string, rootPath: string, serverArgs: string[] = [], private extraEnv: Record<string, string> = {}, private awaitProgress: boolean = false) {
    this.serverCmd = serverCmd;
    this.serverArgs = serverArgs;
    this.rootPath = path.resolve(rootPath);
  }

  public async start(): Promise<boolean> {
    try {
      this.child = spawn(this.serverCmd, this.serverArgs, {
        cwd: this.rootPath,
        env: { ...buildLspEnvironment(this.rootPath), ...this.extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stderr?.resume();

      this.child.on("error", () => {
        this.initialized = false;
      });

      this.child.on("exit", () => {
        this.initialized = false;
        this.failInFlight(new Error(`LSP server '${this.serverCmd}' exited`));
      });
      this.child.stdin?.on("error", () => {
        this.initialized = false;
      });

      this.child.stdout?.on("data", (data: Buffer) => {
        this.handleData(data);
      });

      const rootUri = pathToFileURL(this.rootPath).href;

      // 1. Initialize
      const initRes = await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: true },
            // Ask servers to attach document versions so delayed results for pre-edit content can be rejected.
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            synchronization: { didSave: true },
            // Pull diagnostics, except from a staged server: its lists come from several analyses and arrive by publish;
            // a pull would return one of them.
            ...(this.awaitProgress ? {} : { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } }),
          },
          ...(this.awaitProgress ? {} : { workspace: { diagnostics: { refreshSupport: true } } }),
          // Declared so that servers which report progress (rust-analyzer) send $/progress, which diagnostics wait on.
          window: { workDoneProgress: true },
        },
      }, 5000);

      if (!initRes) return false;
      const sync = initRes.capabilities?.textDocumentSync;
      if (typeof sync === "object" && sync?.save) {
        this.saveOptions = typeof sync.save === "object" ? sync.save : {};
      }
      const provider = initRes.capabilities?.diagnosticProvider;
      if (!this.awaitProgress && provider && typeof provider === "object") {
        this.diagnosticProvider = {
          ...(typeof provider.identifier === "string" ? { identifier: provider.identifier } : {}),
          interFileDependencies: provider.interFileDependencies === true,
          workspaceDiagnostics: provider.workspaceDiagnostics === true,
        };
      }

      // 2. Initialized notification
      this.sendNotification("initialized", {});
      this.initialized = true;
      return true;
    } catch {
      this.initialized = false;
      return false;
    }
  }

  /** Rejects every request still waiting and wakes every diagnostics waiter: the server is gone, so no answer is coming. */
  private failInFlight(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    const waiters = [...this.diagnosticWaiters.values()].flat();
    this.diagnosticWaiters.clear();
    for (const w of waiters) w();
  }

  /** A server that sends more than the cap in one message, or buffers past it, is dropped rather than trusted with memory. */
  private dropOversized(): void {
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.failInFlight(new Error(`LSP server '${this.serverCmd}' exceeded the ${LSP_MAX_BUFFER_BYTES}-byte message limit`));
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      if (contentLength > LSP_MAX_BUFFER_BYTES) return this.dropOversized();
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) {
        // Incomplete body, wait for next chunk
        break;
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (typeof msg.method === "string" && msg.id !== undefined) {
          // A request FROM the server (it has a method; its id space is its own, so it can collide with ours): answer it, or
          // a server that waits for the reply (window/workDoneProgress/create, workspace/configuration) can stall.
          this.answerServerRequest(msg);
          continue;
        }
        if (msg.method === "$/progress" && msg.params) {
          const token = String(msg.params.token);
          const kind = msg.params.value?.kind;
          if (kind === "begin") this.progressActive.set(token, this.seq);
          else if (kind === "end") {
            this.progressSettledSeq = Math.max(this.progressSettledSeq, this.progressActive.get(token) ?? 0);
            this.progressActive.delete(token);
          }
          this.progressSeen = true;
          this.lastProgressAt = Date.now();
          this.wake(ANY_DOCUMENT);
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { code: msg.error.code, data: msg.error.data }));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          const params = msg.params;
          if (params && params.uri && Array.isArray(params.diagnostics)) {
            this.lastPublishAt = Date.now();
            this.wake(ANY_DOCUMENT);
            // A list is an answer only for a document the server holds from this client: one published for a file before
            // its first open, or after its close, describes content the client never sent and is not kept.
            const current = this.documentForUri(params.uri);
            if (!current) continue;
            if (typeof params.version === "number") {
              this.versionedPublishes = true;
              if (params.version !== current.version) continue; // published for an older version of the file than the server was last told about
            } else if (this.versionedPublishes) {
              // A server that attaches versions does so for every open document: once it has, a list without one is not
              // about a document as this client sent it (a "cleared" list after a close, arriving after the reopen).
              continue;
            }
            current.diagnostics = { list: toDiagnostics(params.diagnostics), seq: this.seq };
            this.wake(current.key);
          }
        }
      } catch {}
    }
    if (this.buffer.length > LSP_MAX_BUFFER_BYTES + 1024) this.dropOversized();
  }

  public async sendRequest(method: string, params: any, timeoutMs: number = 8000): Promise<any> {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) {
      throw new Error(`LSP server '${this.serverCmd}' is not running`);
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child!.stdin!.write(header + payload);
    });
  }

  private answerServerRequest(msg: { id: number | string; method: string; params?: any }): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    // The server's results changed for a reason the client did not cause: no kept report may stand in for a new one.
    if (msg.method === "workspace/diagnostic/refresh") for (const doc of this.documents.values()) doc.pulled = undefined;
    // Nothing is configured or registered on the server's behalf: an empty answer is a valid one for the requests servers send.
    const result = msg.method === "workspace/configuration" && Array.isArray(msg.params?.items) ? msg.params.items.map(() => null) : null;
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n${payload}`);
  }

  public sendNotification(method: string, params: any): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
    this.child.stdin.write(header + payload);
  }

  /**
   * The open document a server means by `uri`. Servers do not echo the client's spelling: they may publish under the real
   * path where the client sent a symlinked one, and percent-encode differently, so a URI that is not the one sent is
   * decoded to a path and compared with the two paths each document goes by. No file-system access.
   */
  private documentForUri(uri: unknown): OpenDocument | undefined {
    if (typeof uri !== "string") return undefined;
    const exact = this.opened.get(uri);
    if (exact) return exact;
    let named: string;
    try {
      named = comparablePath(fileURLToPath(uri));
    } catch {
      return undefined; // not a file URI
    }
    for (const doc of this.documents.values()) if (doc.paths.includes(named)) return doc;
    return undefined;
  }

  private wake(key: string): void {
    const waiters = this.diagnosticWaiters.get(key);
    if (!waiters) return;
    this.diagnosticWaiters.delete(key);
    for (const w of waiters) w();
  }

  private change(doc: OpenDocument, state: FileState): void {
    Object.assign(doc, state);
    doc.version = doc.changedSeq = this.lastChangeSeq = ++this.seq;
    doc.diagnostics = undefined;
    this.documentChangedAt.set(doc.key, Date.now());
    // Startup progress does not mean work for this newer document version has settled. A server may first
    // publish diagnostics for the updated version before its analysis has caught up; make the bounded grace
    // path apply again unless this edit produces fresh progress notifications.
    this.progressSeen = false;
    this.lastProgressAt = 0;
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.text }],
    });
    if (this.saveOptions) {
      this.sendNotification("textDocument/didSave", {
        textDocument: { uri: doc.uri },
        ...(this.saveOptions.includeText ? { text: doc.text } : {}),
      });
    }
  }

  /** `gone`: the file is no longer there for the server to read, which changes what other files' answers are computed from. */
  private close(doc: OpenDocument, gone: boolean): void {
    this.documents.delete(doc.key);
    this.opened.delete(doc.uri);
    this.documentChangedAt.delete(doc.key);
    if (gone) this.unevidencedSeq = this.lastChangeSeq = ++this.seq;
    else if (!doc.diagnostics) this.unevidencedSeq = Math.max(this.unevidencedSeq, doc.changedSeq);
    this.sendNotification("textDocument/didClose", { textDocument: { uri: doc.uri } });
    this.wake(doc.key);
    this.wake(ANY_DOCUMENT);
  }

  /**
   * Makes every open document match the disk: a file whose content moved gets a full-text didChange (and didSave where
   * the server asked for it); one that is gone, is no longer a regular file, or no longer resolves to itself inside the
   * workspace (renamed, or replaced by a symlink) is closed without being read.
   * Per document: one realpath and one stat; the content is read only when the stamp moved or cannot be trusted yet.
   */
  private resync(realRoot: string | null): void {
    for (const doc of [...this.documents.values()]) {
      let state: FileState | null = null;
      if (realRoot !== null && realOrNull(doc.key) === doc.key && !outsideRoot(realRoot, doc.key)) {
        try {
          const st = fs.statSync(doc.key, { bigint: true });
          if (doc.settled && stampOf(st, 0).stamp === doc.stamp) continue;
          if (st.isFile()) state = readRegularFile(doc.key);
        } catch {}
      }
      if (!state) this.close(doc, true);
      else if (state.text !== doc.text) this.change(doc, state);
      else Object.assign(doc, state);
    }
  }

  /**
   * The one way a query reaches a file: brings every open document up to date with the disk, then opens `filePath` if
   * the server does not hold it yet and closes the least recently queried documents beyond the bound.
   * Throws when the file cannot be read or lies outside the workspace.
   */
  private open(filePath: string, languageId: string): OpenDocument {
    // Resolve symlinks before the containment check: a link inside the workspace must not read a file outside it.
    const realRoot = realOrNull(this.rootPath);
    this.resync(realRoot);
    const key = realRoot === null ? null : realOrNull(path.resolve(this.rootPath, filePath));
    if (realRoot === null || key === null || outsideRoot(realRoot, key)) throw unreadable(filePath);
    let doc = this.documents.get(key);
    if (doc) {
      this.documents.delete(key);
    } else {
      const state = readRegularFile(key);
      if (!state) throw unreadable(filePath);
      // Named as the workspace was given to the server (its rootUri), so a server that relates documents to the root by
      // prefix finds them inside it; below the root the real path, so one file has one name.
      const sent = path.join(this.rootPath, path.relative(realRoot, key));
      doc = { ...state, key, uri: pathToFileURL(sent).href, paths: [comparablePath(sent), comparablePath(key)], version: ++this.seq, changedSeq: 0, waiting: 0 };
      this.opened.set(doc.uri, doc);
      this.sendNotification("textDocument/didOpen", { textDocument: { uri: doc.uri, languageId, version: doc.version, text: doc.text } });
    }
    this.documents.set(key, doc);
    for (const old of this.documents.values()) {
      if (this.documents.size <= MAX_OPEN_DOCUMENTS) break;
      // What the server held was just checked against the disk, so closing it changes nothing the server computes from.
      if (old !== doc && old.waiting === 0) this.close(old, false);
    }
    return doc;
  }

  /**
   * Push-only servers: when a list that arrived at `listSeq`, before a later change to another document, may be taken as
   * still current, or null while nothing shows that the server has dealt with that change. Silence is not evidence:
   *  - a staged server: a progress cycle that began after the latest change has ended, nothing is in progress, and
   *    progress has been quiet for QUIET_MS;
   *  - any other server: it has published for every document changed since the list arrived (that publish shows it
   *    analysed the change), and has published nothing for PUBLISH_QUIET_MS.
   * Known limit: a server that publishes for the changed document, stays silent for longer than the window, and only
   * then publishes a different list for this document has its old list returned as current once. A server that offers
   * pull diagnostics is asked instead and has no such window.
   */
  private settledAt(listSeq: number): number | null {
    if (this.awaitProgress) {
      return this.progressSettledSeq >= this.lastChangeSeq && this.progressActive.size === 0 ? this.lastProgressAt + QUIET_MS : null;
    }
    if (this.unevidencedSeq > listSeq) return null;
    for (const doc of this.documents.values()) if (doc.changedSeq > listSeq && !doc.diagnostics) return null;
    return this.lastPublishAt + PUBLISH_QUIET_MS;
  }

  /**
   * The diagnostics for the file as it is on disk now, or why there are none to report.
   * From a server that offers pull diagnostics: its reply to a request made after the sync.
   * Otherwise from what it published: a list counts when it arrived after the latest change the client had sent when
   * this call began (and, where the server attaches versions, for this document's version), or when it is older than a
   * change to another document and `settledAt` says the server has dealt with that change. Throws for an unreadable file.
   */
  public async waitForDiagnostics(filePath: string, languageId: string, timeoutMs: number): Promise<DiagnosticsAnswer> {
    const doc = this.open(filePath, languageId);
    if (this.diagnosticProvider) return this.pullDiagnostics(doc, filePath, timeoutMs, this.diagnosticProvider.identifier);
    const key = doc.key;
    const since = this.lastChangeSeq;
    const held = () => this.documents.get(key)?.diagnostics;
    const current = (): LspDiagnostic[] | null => {
      const d = held();
      return d && d.seq >= since ? d.list : null;
    };
    const stands = (now: number): LspDiagnostic[] | null => {
      const d = held();
      const at = d ? this.settledAt(d.seq) : null;
      return d && at !== null && now >= at ? d.list : null;
    };
    const startedAt = Date.now();
    const changedAt = this.documentChangedAt.get(key);
    doc.waiting++;
    try {
      // A staged server's first publish may be empty. Wait until its progress has ended and been quiet for a moment (or, if it
      // never reports progress, for a grace period), within the caller's timeout, then return the latest list.
      const GRACE_MS = 4000;
      for (let now = startedAt; now - startedAt < timeoutMs; now = Date.now()) {
        if (!current()) {
          if (stands(now)) break;
          // No list: wait for one. A list from before another document's change: wait for the server to publish or end
          // progress, or for the moment its quiet period is over.
          const d = held();
          const at = d ? this.settledAt(d.seq) : null;
          const left = timeoutMs - (now - startedAt);
          await this.nextPublish(d ? ANY_DOCUMENT : key, at === null ? left : Math.min(left, Math.max(1, at - now)));
          if (!this.documents.has(key) || !this.initialized) break; // closed, or the server is gone
          continue;
        }
        if (!this.awaitProgress) break;
        const idle = this.progressActive.size === 0;
        const settled = this.progressSeen ? now - this.lastProgressAt >= QUIET_MS : now - startedAt >= GRACE_MS;
        const editSettled = changedAt === undefined || now - changedAt >= EDIT_DIAGNOSTICS_GRACE_MS;
        if (idle && settled && editSettled) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.awaitProgress && changedAt !== undefined && Date.now() - changedAt >= EDIT_DIAGNOSTICS_GRACE_MS) this.documentChangedAt.delete(key);
      const diagnostics = current() ?? stands(Date.now());
      if (diagnostics) return { status: "ok", diagnostics };
      const what = held() ? `for ${filePath} after another open file changed,` : `for ${filePath}`;
      return { status: "unavailable", reason: `Language server '${this.serverCmd}' published no diagnostics ${what} within ${timeoutMs}ms.` };
    } finally {
      doc.waiting--;
    }
  }

  /**
   * One `textDocument/diagnostic` exchange. A full report is the answer and is kept with its `resultId`; "unchanged" is
   * an answer only for the kept list that `resultId` was sent for. Reports for related documents are not used. Asked
   * again when the server cancels with `retriggerRequest`, a bounded number of times within the timeout.
   */
  private async pullDiagnostics(doc: OpenDocument, filePath: string, timeoutMs: number, identifier?: string): Promise<DiagnosticsAnswer> {
    const deadline = Date.now() + timeoutMs;
    const unavailable = (why: string): DiagnosticsAnswer => ({ status: "unavailable", reason: `Language server '${this.serverCmd}' gave no diagnostics for ${filePath}: ${why}` });
    for (let attempt = 0; ; attempt++) {
      const previousResultId = doc.pulled?.resultId;
      let report: any;
      try {
        report = await this.sendRequest(
          "textDocument/diagnostic",
          { textDocument: { uri: doc.uri }, ...(identifier !== undefined ? { identifier } : {}), ...(previousResultId !== undefined ? { previousResultId } : {}) },
          Math.max(1, deadline - Date.now()),
        );
      } catch (err: any) {
        if (err.code === SERVER_CANCELLED && err.data?.retriggerRequest === true && attempt < PULL_RETRIGGER_LIMIT && Date.now() < deadline) continue;
        return unavailable(`${err.message}.`);
      }
      if (report?.kind === "full" && Array.isArray(report.items)) {
        doc.pulled = { list: toDiagnostics(report.items), ...(typeof report.resultId === "string" ? { resultId: report.resultId } : {}) };
        return { status: "ok", diagnostics: doc.pulled.list };
      }
      if (report?.kind === "unchanged" && previousResultId !== undefined) {
        if (doc.pulled) {
          if (typeof report.resultId === "string") doc.pulled.resultId = report.resultId;
          return { status: "ok", diagnostics: doc.pulled.list };
        }
        // The kept list was dropped while the request was out (workspace/diagnostic/refresh): ask for a full report.
        if (attempt < PULL_RETRIGGER_LIMIT && Date.now() < deadline) continue;
      }
      return unavailable("its report was neither a full list nor 'unchanged' for a list this client holds.");
    }
  }

  /** Resolves when a list is accepted for the document, when it is closed, when the server is gone, or at the timeout. */
  private nextPublish(key: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.diagnosticWaiters.get(key)?.filter((w) => w !== done) ?? [];
        if (list.length) this.diagnosticWaiters.set(key, list);
        else this.diagnosticWaiters.delete(key);
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.diagnosticWaiters.set(key, [...(this.diagnosticWaiters.get(key) ?? []), done]);
    });
  }

  public pid(): number | undefined {
    return this.child?.pid;
  }

  public async getHover(filePath: string, languageId: string, line: number, character: number): Promise<string | null> {
    const { uri } = this.open(filePath, languageId);
    const res = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });

    if (!res || !res.contents) return null;

    if (typeof res.contents === "string") return res.contents;
    if (res.contents.value) return res.contents.value;
    if (Array.isArray(res.contents)) {
      return res.contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
    }
    return JSON.stringify(res.contents);
  }

  public async getDefinition(filePath: string, languageId: string, line: number, character: number): Promise<LspLocation[] | null> {
    const { uri } = this.open(filePath, languageId);
    const res = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });

    if (!res) return null;
    if (Array.isArray(res)) return res;
    if (res.uri && res.range) return [res];
    return null;
  }

  public shutdown(): void {
    if (this.child) {
      try {
        this.sendRequest("shutdown", {}).catch(() => {});
        this.sendNotification("exit", {});
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
    }
    this.initialized = false;
  }
}

/**
 * Manager to auto-route LSP queries based on file extension
 */
export class LspBridgeManager {
  private static live: Set<LspBridgeManager> = new Set();
  private static exitHookInstalled = false;

  private workspace: string;
  private clients: Map<string, LspClient> = new Map();
  private starting: Map<string, Promise<LspClient | null>> = new Map();
  private closed = false;
  private servers: Record<string, LspServerSpec>;
  private gate?: () => string | null;

  /** `gate` returns the reason a server must not start right now (untrusted workspace, sandbox), or null to allow it. */
  constructor(workspace: string, opts: { servers?: Record<string, LspServerSpec>; gate?: () => string | null } = {}) {
    this.workspace = path.resolve(workspace);
    this.gate = opts.gate;
    this.servers = opts.servers ?? {};
    LspBridgeManager.live.add(this);
    if (!LspBridgeManager.exitHookInstalled) {
      LspBridgeManager.exitHookInstalled = true;
      // Backstop: a language server must never outlive the process, even if no owner called shutdownAll.
      process.on("exit", () => {
        for (const m of LspBridgeManager.live) m.shutdownAll();
      });
    }
  }

  /** The gate's refusal, if any. A refusal also stops servers that started while the workspace was still allowed. */
  private refusal(): string | null {
    const reason = this.gate?.() ?? null;
    if (reason) {
      for (const client of this.clients.values()) client.shutdown();
      this.clients.clear();
    }
    return reason;
  }

  public getServerForFile(filePath: string): LspServerSpec | null {
    const ext = path.extname(filePath).toLowerCase();
    if (this.servers[ext]) return this.servers[ext];
    if (ext === ".rs") {
      return { cmd: "rust-analyzer", languageId: "rust", awaitProgress: true };
    }
    if (ext === ".ts" || ext === ".tsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "typescript" };
    }
    if (ext === ".js" || ext === ".jsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "javascript" };
    }
    if (ext === ".py") {
      return { cmd: "pyright-langserver", args: ["--stdio"], languageId: "python" };
    }
    if (ext === ".go") {
      return { cmd: "gopls", languageId: "go" };
    }
    return null;
  }

  public async getClientForFile(filePath: string): Promise<LspClient | null> {
    const serverInfo = this.getServerForFile(filePath);
    if (!serverInfo || this.refusal()) return null;
    this.closed = false;
    LspBridgeManager.live.add(this);
    const key = `${serverInfo.cmd}\0${(serverInfo.args ?? []).join("\0")}`;

    const existing = this.clients.get(key);
    if (existing?.initialized) return existing;
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const startup = (async () => {
      const client = new LspClient(serverInfo.cmd, this.workspace, serverInfo.args ?? [], serverInfo.env, serverInfo.awaitProgress === true);
      const ok = await client.start();
      if (ok && this.closed) {
        client.shutdown();
        return null;
      }
      if (ok) {
        this.clients.set(key, client);
        return client;
      }
      client.shutdown();
      return null;
    })().finally(() => this.starting.delete(key));
    this.starting.set(key, startup);
    return startup;
  }

  /**
   * Diagnostics for one file. "ok" means the server published for this file's current content (an empty list is then a
   * real "no errors"); "unavailable" means no answer, which callers must not read as a clean file.
   */
  public async diagnostics(
    filePath: string,
    timeoutMs: number = 5000,
  ): Promise<DiagnosticsAnswer> {
    const info = this.getServerForFile(filePath);
    if (!info) return { status: "unavailable", reason: `No LSP server configured for ${filePath}.` };
    const refused = this.refusal();
    if (refused) return { status: "unavailable", reason: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) return { status: "unavailable", reason: `Language server '${info.cmd}' is not installed or failed to start.` };
    try {
      return await client.waitForDiagnostics(filePath, info.languageId, timeoutMs);
    } catch (err: any) {
      return { status: "unavailable", reason: err.message };
    }
  }

  public serverPids(): number[] {
    return [...this.clients.values()].map((c) => c.pid()).filter((p): p is number => typeof p === "number");
  }

  public async hover(filePath: string, line: number, character: number): Promise<{ found: boolean; hoverText?: string; error?: string }> {
    const refused = this.getServerForFile(filePath) ? this.refusal() : null;
    if (refused) return { found: false, error: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) {
      const info = this.getServerForFile(filePath);
      return {
        found: false,
        error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
      };
    }

    try {
      const text = await client.getHover(filePath, this.getServerForFile(filePath)!.languageId, line, character);
      return { found: Boolean(text), hoverText: text || "No hover documentation available." };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public async definition(filePath: string, line: number, character: number): Promise<{ found: boolean; locations?: LspLocation[]; error?: string }> {
    const refused = this.getServerForFile(filePath) ? this.refusal() : null;
    if (refused) return { found: false, error: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) {
      const info = this.getServerForFile(filePath);
      return {
        found: false,
        error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
      };
    }

    try {
      const locations = await client.getDefinition(filePath, this.getServerForFile(filePath)!.languageId, line, character);
      return { found: Boolean(locations && locations.length > 0), locations: locations || [] };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public shutdownAll(): void {
    this.closed = true;
    for (const client of this.clients.values()) {
      client.shutdown();
    }
    this.clients.clear();
    LspBridgeManager.live.delete(this);
  }
}
