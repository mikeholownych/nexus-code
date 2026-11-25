/**
 * BG-3: the file-change watcher of one trigger. Bounded in every direction, and quiet by design:
 *
 *  - at most `maxDirs` directories are watched (the walk starts at the directory each glob names and never follows a
 *    symbolic link), and the runner shares one `DirBudget` across all its watchers;
 *  - at most `maxPending` distinct changed paths wait for the next window; later ones are only counted (`droppedPending`);
 *  - events are coalesced: the first event opens a window of `debounceMs` and everything inside it is one batch.
 *    The watcher holds no timer: the runner's tick calls `drain`, so a closed watcher leaves nothing behind;
 *  - `.git/`, `.nexus/` and the trigger files never count (trigger_paths.ts), and a path whose real path leaves the
 *    workspace is dropped and counted (`droppedEscape`);
 *  - a watcher error (inotify limits, a vanished directory) is kept in `errors` and shown, never swallowed.
 *
 * What an event carries is the workspace-relative path only, and the watcher decides nothing about firing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { globToRegExp, globWatchRoot, isExcludedEventPath, resolveInside, EXCLUDED_SEGMENTS } from "./trigger_paths.js";

export const DEFAULT_MAX_DIRS = 256;
export const DEFAULT_MAX_TOTAL_DIRS = 1024;
export const DEFAULT_MAX_PENDING = 1000;
export const DEFAULT_DEBOUNCE_MS = 2_000;
const MAX_ERRORS = 5;

export type WatchFactory = (dir: string, listener: (event: string, name: string | Buffer | null) => void) => fs.FSWatcher;

/** Directories the runner may watch in all, across triggers. */
export class DirBudget {
  private used = 0;
  constructor(readonly max: number = DEFAULT_MAX_TOTAL_DIRS) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  give(count: number): void {
    this.used = Math.max(0, this.used - count);
  }
}

export interface WatchBatch {
  /** Distinct changed paths, workspace-relative with `/`, sorted. */
  paths: string[];
  /** Paths beyond the pending bound that were counted but not kept. */
  droppedPending: number;
  /** Paths that resolved outside the workspace in this window. */
  droppedEscape: number;
}

export interface FileWatcherOptions {
  /** The workspace's real path. */
  workspace: string;
  globs: readonly string[];
  budget: DirBudget;
  maxDirs?: number;
  maxPending?: number;
  debounceMs?: number;
  watch?: WatchFactory;
  /** The clock `drain` is called with (epoch ms). */
  now?: () => number;
}

const defaultWatch: WatchFactory = (dir, listener) => fs.watch(dir, { persistent: false }, listener);

export class FileTriggerWatcher {
  private readonly matchers: RegExp[];
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pending = new Set<string>();
  private firstAt: number | undefined;
  private droppedPending = 0;
  private droppedEscape = 0;
  private rescan = true;
  private closed = false;
  readonly errors: string[] = [];
  /** The walk reached `maxDirs` or the shared budget: some directories are not watched. */
  truncated = false;

  constructor(private readonly options: FileWatcherOptions) {
    this.matchers = options.globs.map(globToRegExp);
  }

  get dirs(): number {
    return this.watchers.size;
  }

  private note(message: string): void {
    if (this.errors.length < MAX_ERRORS && !this.errors.includes(message)) this.errors.push(message);
  }

  /** Watches every directory the globs need that is not watched yet. Called by the runner's tick, cheap when nothing changed. */
  reconcile(): void {
    if (this.closed || !this.rescan) return;
    this.rescan = false;
    const maxDirs = this.options.maxDirs ?? DEFAULT_MAX_DIRS;
    const roots = new Map<string, number>();
    for (const glob of this.options.globs) {
      const { prefix, depth } = globWatchRoot(glob);
      const root = path.join(this.options.workspace, ...prefix);
      roots.set(root, Math.max(roots.get(root) ?? 0, depth));
    }
    const walk: Array<[string, number]> = [...roots.entries()];
    for (let i = 0; i < walk.length; i++) {
      const [dir, depth] = walk[i]!;
      if (!this.watchers.has(dir)) {
        if (this.watchers.size >= maxDirs || !this.options.budget.take()) {
          this.truncated = true;
          this.note(`watching stopped at ${this.watchers.size} directories (limit ${maxDirs}, shared limit ${this.options.budget.max}); changes in the others are not seen`);
          continue;
        }
        if (!this.attach(dir)) {
          this.options.budget.give(1);
          continue;
        }
      }
      if (depth <= 0) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        this.note(`cannot read ${path.relative(this.options.workspace, dir) || "."}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
        continue;
      }
      for (const entry of entries) {
        // A symbolic link is never followed: what it points at is not the workspace's own tree.
        if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_SEGMENTS.includes(entry.name)) continue;
        walk.push([path.join(dir, entry.name), depth - 1]);
      }
    }
  }

  private attach(dir: string): boolean {
    const watch = this.options.watch ?? defaultWatch;
    try {
      const watcher = watch(dir, (event, name) => this.onEvent(dir, event, name));
      watcher.on("error", (error: NodeJS.ErrnoException) => {
        this.note(`watching ${path.relative(this.options.workspace, dir) || "."} failed: ${error.code ?? error.message}`);
        watcher.close();
        this.watchers.delete(dir);
        this.options.budget.give(1);
      });
      this.watchers.set(dir, watcher);
      return true;
    } catch (error) {
      this.note(`cannot watch ${path.relative(this.options.workspace, dir) || "."}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      return false;
    }
  }

  private onEvent(dir: string, event: string, name: string | Buffer | null): void {
    if (this.closed || name === null) return;
    const absolute = path.join(dir, String(name));
    const relative = path.relative(this.options.workspace, absolute).split(path.sep).join("/");
    if (relative === "" || relative.startsWith("../") || relative === ".." || isExcludedEventPath(relative)) return;
    // A directory that appeared or went: look for directories to watch again at the next tick.
    if (event === "rename") this.rescan = true;
    if (!this.matchers.some((matcher) => matcher.test(relative))) return;
    if (resolveInside(this.options.workspace, absolute) === undefined) {
      this.droppedEscape++;
      return;
    }
    if (this.pending.has(relative)) return;
    if (this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      this.droppedPending++;
      return;
    }
    this.pending.add(relative);
    this.firstAt ??= this.options.now?.() ?? Date.now();
  }

  /** The batch of the window that has ended (its first event is `debounceMs` old), or undefined. Resets the window. */
  drain(nowMs: number): WatchBatch | undefined {
    if (this.closed) return undefined;
    const drops = this.droppedPending > 0 || this.droppedEscape > 0;
    if (this.firstAt === undefined ? !drops : nowMs - this.firstAt < (this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)) return undefined;
    const batch: WatchBatch = { paths: [...this.pending].sort(), droppedPending: this.droppedPending, droppedEscape: this.droppedEscape };
    this.pending.clear();
    this.firstAt = undefined;
    this.droppedPending = 0;
    this.droppedEscape = 0;
    return batch;
  }

  /** Memory held right now, for tests of the bound. */
  pendingCount(): number {
    return this.pending.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.options.budget.give(this.watchers.size);
    this.watchers.clear();
    this.pending.clear();
  }
}
