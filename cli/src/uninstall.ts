import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJournal } from "./upgrade_journal.js";

type ManifestFile = { relativePath: string; sha256: string };
type UninstallLock = { path: string; fd: number; ino: number; token: string };

function acquireUninstallLock(libNexus: string): UninstallLock {
  const lockPath = path.join(libNexus, ".upgrade.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error("An upgrade is active or its lock needs recovery; uninstall refused before changing anything.");
    }
    throw new Error(`Could not acquire the upgrade lock for uninstall: ${error?.message ?? error}`);
  }
  const ino = fs.fstatSync(fd).ino;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    fs.fsyncSync(fd);
    return { path: lockPath, fd, ino, token };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try {
      const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (current?.ino === ino && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(lockPath);
    } catch {}
    throw error;
  }
}

function releaseUninstallLock(lock: UninstallLock): void {
  try { fs.closeSync(lock.fd); } catch {}
  try {
    const current = fs.lstatSync(lock.path, { throwIfNoEntry: false });
    if (!current || current.ino !== lock.ino || !current.isFile() || current.isSymbolicLink()) return;
    const value = JSON.parse(fs.readFileSync(lock.path, "utf8"));
    if (value?.pid === process.pid && value?.token === lock.token) fs.unlinkSync(lock.path);
  } catch {}
}

function readPackageManifest(root: string): ManifestFile[] {
  const manifestPath = path.join(root, "MANIFEST.sha256");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Install manifest is not a regular file; nothing was removed.");
  }
  const rows: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/i);
    if (!match) throw new Error("Install manifest contains an invalid entry; nothing was removed.");
    const raw = match[2];
    const relativePath = raw.startsWith("./") ? raw.slice(2) : raw;
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
      throw new Error("Install manifest contains a path outside the installation; nothing was removed.");
    }
    if (relativePath === "MANIFEST.sha256" || relativePath === ".provenance.json" || seen.has(relativePath)) {
      throw new Error("Install manifest contains a duplicate or reserved entry; nothing was removed.");
    }
    seen.add(relativePath);
    rows.push({ relativePath, sha256: match[1].toLowerCase() });
  }
  if (rows.length === 0) throw new Error("Install manifest is empty; nothing was removed.");
  return rows;
}

function inventoryPackage(root: string): { files: Set<string>; directories: Set<string> } {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = (dir: string, relative: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Install contains a symbolic link (${rel}); nothing was removed.`);
      if (stat.isDirectory()) {
        directories.add(rel);
        visit(full, rel);
      }
      else if (stat.isFile()) files.add(rel);
      else throw new Error(`Install contains a non-regular entry (${rel}); nothing was removed.`);
    }
  };
  visit(root, "");
  files.delete("MANIFEST.sha256");
  files.delete(".provenance.json");
  return { files, directories };
}

function verifyInstall(root: string, prefix: string): string {
  const manifest = readPackageManifest(root);
  const actual = inventoryPackage(root);
  const expected = new Set(manifest.map((row) => row.relativePath));
  if (actual.files.size !== expected.size || [...actual.files].some((file) => !expected.has(file))) {
    throw new Error("Install contents do not exactly match the manifest; nothing was removed.");
  }
  const expectedDirectories = new Set<string>();
  for (const file of expected) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join("/"));
  }
  if (actual.directories.size !== expectedDirectories.size || [...actual.directories].some((dir) => !expectedDirectories.has(dir))) {
    throw new Error("Install contains directories not implied by the manifest; nothing was removed.");
  }
  for (const row of manifest) {
    const full = path.resolve(root, row.relativePath);
    if (!full.startsWith(`${root}${path.sep}`)) throw new Error("Install manifest escapes the installation; nothing was removed.");
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Manifest entry is not a regular file (${row.relativePath}); nothing was removed.`);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    if (digest !== row.sha256) throw new Error(`Install file does not match the manifest (${row.relativePath}); nothing was removed.`);
  }

  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
  if (!/^v\d+\.\d+\.\d+(?:-[-0-9A-Za-z.]+)?$/.test(version)) throw new Error("Installed version identity is invalid; nothing was removed.");
  if (/^v\d+\.\d+\.\d+(?:-[-0-9A-Za-z.]+)?$/.test(path.basename(root)) && version !== path.basename(root)) {
    throw new Error("Installed version identity does not match its directory; nothing was removed.");
  }
  const provenancePath = path.join(root, ".provenance.json");
  if (fs.existsSync(provenancePath)) {
    let provenance: any;
    try { provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")); }
    catch { throw new Error("Install provenance is invalid; nothing was removed."); }
    if (provenance?.product !== "nexus-code" || provenance?.managed !== true ||
        path.resolve(provenance?.prefix ?? "") !== prefix || path.basename(path.resolve(provenance?.installedPath ?? "")) !== version) {
      throw new Error("Install provenance does not identify this managed package; nothing was removed.");
    }
  }
  return version;
}

function removeUserState(home: string): string[] {
  const removed: string[] = [];
  for (const target of [path.join(home, ".nexus"), path.join(home, ".config", "nexus")]) {
    try {
      fs.lstatSync(target);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    fs.rmSync(target, { recursive: true, force: false });
    removed.push(target);
  }
  return removed;
}

export function uninstallManagedInstall(options: { installRoot: string; home?: string; purge?: boolean }): { removedInstall: string; removedLauncher: boolean; purgedState: string[] } {
  const home = path.resolve(options.home ?? os.homedir());
  const installRoot = path.resolve(options.installRoot);
  const expectedParent = path.join(path.dirname(path.dirname(path.dirname(installRoot))), "lib", "nexus");
  if (path.dirname(installRoot) !== expectedParent || path.basename(installRoot) === "" || !fs.existsSync(installRoot)) {
    throw new Error("The detected install path is not a version directory under <prefix>/lib/nexus; nothing was removed.");
  }
  const installStat = fs.lstatSync(installRoot);
  if (!installStat.isDirectory() || installStat.isSymbolicLink()) throw new Error("Install root is not a regular directory; nothing was removed.");
  const prefix = path.dirname(path.dirname(path.dirname(installRoot)));
  const libNexus = path.join(prefix, "lib", "nexus");
  const libNexusStat = fs.lstatSync(libNexus);
  if (!libNexusStat.isDirectory() || libNexusStat.isSymbolicLink() || fs.realpathSync(libNexus) !== libNexus) {
    throw new Error("Install directory is redirected or not a real directory; nothing was removed.");
  }
  const lock = acquireUninstallLock(libNexus);
  let result: { removedLauncher: boolean; purgedState: string[] };
  try {
    const packages: string[] = [];
    for (const name of fs.readdirSync(libNexus)) {
      const candidate = path.join(libNexus, name);
      if (name === ".upgrade.lock") {
        const stat = fs.lstatSync(candidate);
        const lockStat = fs.fstatSync(lock.fd);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== lockStat.ino) {
          throw new Error("Upgrade lock changed during uninstall preflight; nothing was removed.");
        }
        continue;
      }
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Install tree contains a symbolic link (${name}); nothing was removed.`);
      if (stat.isDirectory() && (/^v\d+\.\d+\.\d+(?:-[-0-9A-Za-z.]+)?$/.test(name) || /^\.(?:rollback|failed)-[A-Za-z0-9._-]+$/.test(name))) {
        verifyInstall(candidate, prefix);
        packages.push(candidate);
        continue;
      }
      if (stat.isFile() && name === ".upgrade-journal.json") {
        const journal = readJournal(prefix);
        if (!journal || !["idle", "complete", "rolled_back"].includes(journal.state)) {
          throw new Error("An incomplete or invalid upgrade journal must be recovered before uninstall; nothing was removed.");
        }
        continue;
      }
      throw new Error(`Install tree contains an unrecognized entry (${name}); nothing was removed.`);
    }
    if (!packages.includes(installRoot)) throw new Error("The detected package is not part of the verified install tree; nothing was removed.");

    const launcher = path.join(prefix, "bin", "nexus");
    const binDir = path.dirname(launcher);
    const binStat = fs.lstatSync(binDir);
    if (!binStat.isDirectory() || binStat.isSymbolicLink() || fs.realpathSync(binDir) !== binDir) {
      throw new Error("Launcher directory is redirected or not a real directory; nothing was removed.");
    }
    let removeLauncher = false;
    try {
      const launcherStat = fs.lstatSync(launcher);
      if (launcherStat.isSymbolicLink()) {
        const target = fs.readlinkSync(launcher);
        const resolvedTarget = path.resolve(path.dirname(launcher), target);
        if (packages.some((pkg) => resolvedTarget === path.join(pkg, "bin", "nexus"))) removeLauncher = true;
        else throw new Error("The Nexus launcher points to a different install; nothing was removed.");
      } else {
        throw new Error("The Nexus launcher is not a symbolic link; nothing was removed.");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    // Validate every potentially destructive target before the first mutation.
    const purgeTargets = options.purge ? [path.join(home, ".nexus"), path.join(home, ".config", "nexus")] : [];
    if (options.purge && fs.realpathSync(home) !== home) throw new Error("Operator home is redirected; state purge was refused.");
    const configParent = path.join(home, ".config");
    try {
      const configStat = fs.lstatSync(configParent);
      if (!configStat.isDirectory() || configStat.isSymbolicLink() || fs.realpathSync(configParent) !== configParent) {
        throw new Error("Operator config directory is redirected; state purge was refused.");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const target of purgeTargets) {
      try { fs.lstatSync(target); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }

    for (const pkg of packages) fs.rmSync(pkg, { recursive: true, force: false });
    if (removeLauncher) fs.unlinkSync(launcher);
    const purgedState = options.purge ? removeUserState(home) : [];
    result = { removedLauncher: removeLauncher, purgedState };
  } finally {
    releaseUninstallLock(lock);
  }
  try { fs.rmdirSync(libNexus); }
  catch (error: any) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
    throw new Error("The install directory changed during uninstall; verified packages and launcher were removed, but the directory now contains a concurrent upgrade. Inspect it before retrying.");
  }
  return { removedInstall: installRoot, ...result };
}

export function uninstallCommand(options: { purge?: boolean }): void {
  try {
    const installRoot = process.env.NEXUS_HOME;
    if (!installRoot) throw new Error("nexus uninstall is available only from a managed packaged installation.");
    const result = uninstallManagedInstall({ installRoot, purge: options.purge });
    console.log(`Removed Nexus install: ${result.removedInstall}`);
    if (result.removedLauncher) console.log("Removed Nexus launcher.");
    if (options.purge) console.log(`Purged ${result.purgedState.length} Nexus state/configuration path(s).`);
  } catch (error: any) {
    console.error(`nexus uninstall: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
