// Shared by the managed-policy tests: a seeded generator of policy documents, a writer of policy text, and an
// in-memory file system for the loader. Nothing here touches a real policy file.
import type { PolicyDocument } from "../../src/core/managed_policy.js";
import type { PolicyFs, PolicyStat } from "../../src/core/managed_policy_load.js";
import { renderPolicyTomlString } from "../../src/core/managed_policy_toml.js";

/** mulberry32: a small deterministic generator, so every run sees the same documents. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type KeyRule = "or" | "union" | "intersection" | "max";
export interface KeyRow {
  table: string;
  key: string;
  rule: KeyRule;
  /** For a list: two valid items. For `max`: the values, least restrictive first. */
  values: readonly string[];
}

/**
 * The keys of a policy document and how tiers combine, typed by hand from the table in the implementation plan. The
 * tests' oracles use this list, never `POLICY_KEYS`; one test checks the two name the same keys.
 */
export const PLAN_KEYS: readonly KeyRow[] = [
  { table: "approval", key: "strict", rule: "or", values: [] },
  { table: "approval", key: "disable_auto", rule: "or", values: [] },
  { table: "approval", key: "disable_yes", rule: "or", values: [] },
  { table: "approval", key: "disable_full_access", rule: "or", values: [] },
  { table: "approval", key: "require_human", rule: "union", values: ["exec", "egress"] },
  { table: "verification", key: "mode", rule: "max", values: ["approve", "block"] },
  { table: "verification", key: "protected", rule: "union", values: ["ci/**", "scripts/verify.sh"] },
  { table: "commands", key: "forbid", rule: "union", values: ["git push", "rm -rf"] },
  { table: "commands", key: "prompt", rule: "union", values: ["npm publish", "docker run"] },
  { table: "commands", key: "disable_allow_rules", rule: "or", values: [] },
  { table: "paths", key: "protected", rule: "union", values: [".env", "secrets/**"] },
  { table: "egress", key: "inspector", rule: "max", values: ["record", "block"] },
  { table: "egress", key: "allowed_domains", rule: "intersection", values: ["example.com", "*.example.org"] },
  { table: "egress", key: "secret_destinations", rule: "intersection", values: ["https://api.example.com", "https://gateway.example.org:8443"] },
  { table: "sandbox", key: "required", rule: "or", values: [] },
  { table: "sandbox", key: "forbid_network", rule: "or", values: [] },
  { table: "mcp", key: "allow", rule: "intersection", values: ["github", "command:/usr/local/bin/mcp-files"] },
  { table: "mcp", key: "disable_workspace", rule: "or", values: [] },
  { table: "plugins", key: "allow", rule: "intersection", values: [`sha256:${"ab".repeat(32)}`, "file:/opt/nexus/plugins/audit.mjs"] },
  { table: "plugins", key: "disable_workspace", rule: "or", values: [] },
  { table: "workspace", key: "disable_env_trust", rule: "or", values: [] },
];

export type Loose = Record<string, Record<string, unknown> | undefined>;

/** The small domain of one key's value in one tier; `undefined` is "the tier does not set the key". */
export function domainOf(row: KeyRow): unknown[] {
  if (row.rule === "or") return [undefined, false, true];
  if (row.rule === "max") return [undefined, ...row.values];
  const [a, b] = row.values;
  return [undefined, [], [a], [b], [a, b]];
}

export function documentWith(row: KeyRow, value: unknown): PolicyDocument {
  return (value === undefined ? {} : { [row.table]: { [row.key]: value } }) as PolicyDocument;
}

/** A random document over the same domains: each key set with probability one half. */
export function randomDocument(random: () => number): PolicyDocument {
  const out: Loose = {};
  for (const row of PLAN_KEYS) {
    if (random() < 0.5) continue;
    const domain = domainOf(row).slice(1);
    (out[row.table] ??= {})[row.key] = domain[Math.floor(random() * domain.length)];
  }
  return out as PolicyDocument;
}

/** Policy text for a document, in the accepted grammar. `style` varies the layout the parser must not care about. */
export function renderPolicyToml(document: PolicyDocument, options: { version?: number | null; random?: () => number } = {}): string {
  const random = options.random ?? (() => 0);
  const eol = random() < 0.3 ? "\r\n" : "\n";
  const lines: string[] = [];
  if (random() < 0.4) lines.push("# managed policy");
  if (options.version !== null) lines.push(`schema_version = ${options.version ?? 1}${random() < 0.3 ? " # required" : ""}`);
  for (const [table, keys] of Object.entries(document as Loose)) {
    if (!keys) continue;
    if (random() < 0.5) lines.push("");
    lines.push(`[${table}]${random() < 0.2 ? "  # table" : ""}`);
    for (const [key, value] of Object.entries(keys)) {
      const pad = random() < 0.3 ? "  " : " ";
      if (Array.isArray(value)) {
        const items = value.map((item) => renderPolicyTomlString(String(item)));
        if (items.length > 0 && random() < 0.5) lines.push(`${key} = [`, ...items.map((item) => `  ${item},${random() < 0.2 ? " # item" : ""}`), "]");
        else lines.push(`${key}${pad}=${pad}[${items.join(", ")}]`);
      } else {
        lines.push(`${key}${pad}=${pad}${typeof value === "string" ? renderPolicyTomlString(value) : String(value)}`);
      }
    }
  }
  return lines.join(eol) + (random() < 0.8 ? eol : "");
}

// ---------------------------------------------------------------------------------------------------------------------

type Node = { kind: "file" | "dir" | "symlink" | "fifo"; bytes: Buffer; uid: number; mode: number; dev: number; ino: number };

const fsError = (code: string): Error => Object.assign(new Error(`${code}: synthetic`), { code });

/** An in-memory `PolicyFs`. Paths are plain strings; nothing is read from or written to disk. */
export class FakeFs implements PolicyFs {
  readonly constants = { O_RDONLY: 0, O_NOFOLLOW: 0o400000, O_NONBLOCK: 0o4000 };
  readonly nodes = new Map<string, Node>();
  /** Error codes to throw, by path. */
  readonly failLstat = new Map<string, string>();
  readonly failOpen = new Map<string, string>();
  readonly failFstat = new Map<string, string>();
  readonly failRead = new Map<string, string>();
  /** What `fstat` reports instead of the node at the path: a file swapped after `lstat`. */
  readonly swapOnOpen = new Map<string, Partial<Node>>();
  /** Bytes the file has when read, when it grew after `fstat`. */
  readonly growOnRead = new Map<string, Buffer>();
  /** Every flag set passed to `open`, and the paths opened, lstat-ed and closed. */
  readonly openFlags: number[] = [];
  readonly touched: string[] = [];
  closed = 0;
  private nextIno = 100;
  private readonly open = new Map<number, { file: string; offset: number }>();
  private nextFd = 10;

  put(file: string, content: string | Uint8Array, attrs: Partial<Omit<Node, "bytes">> = {}): this {
    this.nodes.set(file, { kind: "file", bytes: Buffer.from(content), uid: 0, mode: 0o100644, dev: 1, ino: this.nextIno++, ...attrs });
    return this;
  }
  dir(file: string, attrs: Partial<Omit<Node, "bytes">> = {}): this {
    this.nodes.set(file, { kind: "dir", bytes: Buffer.alloc(0), uid: 0, mode: 0o040755, dev: 1, ino: this.nextIno++, ...attrs });
    return this;
  }

  /** The opened file is owned by `uid`, whatever `lstat` reported. */
  swapOwner(file: string, uid: number): this {
    this.swapOnOpen.set(file, { uid });
    return this;
  }

  private stat(node: Node): PolicyStat {
    return {
      isSymbolicLink: () => node.kind === "symlink",
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      size: node.bytes.length,
      uid: node.uid,
      mode: node.mode,
      dev: node.dev,
      ino: node.ino,
    };
  }
  lstatSync(file: string): PolicyStat {
    this.touched.push(file);
    const fail = this.failLstat.get(file);
    if (fail) throw fsError(fail);
    const node = this.nodes.get(file);
    if (!node) throw fsError("ENOENT");
    return this.stat(node);
  }
  openSync(file: string, flags: number): number {
    this.touched.push(file);
    this.openFlags.push(flags);
    const fail = this.failOpen.get(file);
    if (fail) throw fsError(fail);
    const node = this.nodes.get(file);
    if (!node) throw fsError("ENOENT");
    if (node.kind === "symlink") throw fsError("ELOOP");
    const fd = this.nextFd++;
    this.open.set(fd, { file, offset: 0 });
    return fd;
  }
  fstatSync(fd: number): PolicyStat {
    const { file } = this.open.get(fd)!;
    const fail = this.failFstat.get(file);
    if (fail) throw fsError(fail);
    return this.stat({ ...this.nodes.get(file)!, ...this.swapOnOpen.get(file) });
  }
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number): number {
    const handle = this.open.get(fd)!;
    const fail = this.failRead.get(handle.file);
    if (fail) throw fsError(fail);
    const bytes = this.growOnRead.get(handle.file) ?? this.nodes.get(handle.file)!.bytes;
    // At most 1000 bytes a call, so the loader's read loop is exercised.
    const count = Math.min(length, 1000, bytes.length - handle.offset);
    bytes.copy(buffer, offset, handle.offset, handle.offset + count);
    handle.offset += count;
    return count;
  }
  closeSync(fd: number): void {
    if (!this.open.delete(fd)) throw fsError("EBADF");
    this.closed++;
  }
  get openCount(): number {
    return this.open.size;
  }
}
