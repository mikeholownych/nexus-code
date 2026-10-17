/**
 * Whether a passing verifier run is independent evidence of a change (VERIFIED), or only shows nothing broke
 * (REGRESSION_FREE). Rule (accepted 2026-10-13 after the eval pilot's false VERIFIED): a discovered verifier counts as
 * independent only when tests that existed before the change, unmodified, failed before it and pass after it —
 * fail-before / pass-after. Tests the agent wrote or edited in the same change cannot catch its own misreading of the
 * specification, so they never make a change VERIFIED on their own. (An operator-configured verifier is the operator's
 * own check and is handled by the caller.)
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_TEST_BYTES,
  SKIP_DIRS,
  workspaceRuntimeFiles,
  workspaceTestFiles,
} from "../tester.js";

/** The workspace's verifier run and test files right before the first edit of the current unverified change. */
export interface ChangeBaseline {
  command: string;
  /** The verifier failed (or timed out) before the change. */
  failed: boolean;
  /** Test files then (workspace-relative path → content); null when one was too large to keep. */
  tests: Map<string, string> | null;
  /** Verifier configuration and local runner scripts before the change; null means independence is unprovable. */
  verifier: Map<string, string> | null;
  /** Operator-declared product scope captured before candidate edits; absent scope cannot establish VERIFIED. */
  trustedDeliverables: string[];
  at: string;
}

export function trustedDeliverablesFromBaseline(
  baseline: ChangeBaseline | null | undefined,
): ReadonlySet<string> {
  return new Set(baseline?.trustedDeliverables ?? []);
}

export interface Independence {
  independent: boolean;
  detail: string;
}

/** Commands whose acceptance behavior can be redirected by workspace files and therefore needs a pre-turn snapshot. */
export function requiresWorkspaceVerifierDefinitionBinding(
  command: string,
): boolean {
  const normalized = command.trim();
  return (
    // Arbitrary shell `-c` programs can resolve scripts and test definitions
    // from the workspace. They are intentionally unsupported by the bounded
    // snapshot grammar, so the caller must reject them rather than trust output.
    /\b(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z]*c|--command)\b/.test(
      normalized,
    ) ||
    // Match runner invocations anywhere, including wrappers such as `env npm test`
    // and `bash -c 'npm test'`. Unrecognized wrappers deliberately cannot be
    // snapshotted and therefore fail closed at completion.
    /\b(?:npm|pnpm|yarn)\s+(?:(?:--prefix|--dir)(?:=|\s+)[^\s]+\s+)?(?:(?:run|run-script)\s+)?test\b/.test(
      normalized,
    ) ||
    /\bmake\s+test\b|\bcargo\s+test\b|\bpytest\b|\bpython\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\b(?:bun|deno)\s+test\b|\btsx\s+--test\b/.test(
      normalized,
    ) ||
    /\bnode\s+--test\b/.test(normalized) ||
    // Direct interpreter scripts can be workspace files even when they have
    // no path separator or extension (`node verify`, `sh check`).
    /\b(?:node|python\d?(?:\.\d+)?|bash|sh)\s+(?!-)[^\s;&|]+/.test(
      normalized,
    ) ||
    /\b(?:node|python\d?(?:\.\d+)?|bash|sh)\s+(?:\.\.?\/|[\w.-]+\/)[\w./-]+\.(?:mjs|cjs|js|ts|tsx|py|sh)\b/.test(
      normalized,
    ) ||
    /^(?:(?:\.\.?\/)|[A-Za-z0-9_.-]+\/|(?:node|python\d?(?:\.\d+)?|bash|sh)\s+\S+\.(?:mjs|cjs|js|ts|tsx|py|sh))(?:\s|$)/.test(
      normalized,
    )
  );
}

/** Test files of the workspace by relative path, or null when one exceeds the size kept for restoring. */
export function snapshotTests(workspace: string): Map<string, string> | null {
  const root = path.resolve(workspace);
  const tests = new Map<string, string>();
  for (const file of workspaceTestFiles(root)) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_TEST_BYTES) return null;
    tests.set(path.relative(root, file), fs.readFileSync(file, "utf8"));
  }
  return tests;
}

function runtimeDefinitionFiles(workspace: string): string[] | null {
  const root = path.resolve(workspace);
  const found: string[] = [];
  const walk = (directory: string, depth: number): boolean => {
    if (depth > 5 || found.length >= 128) return false;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!walk(absolute, depth + 1)) return false;
      } else if (entry.isFile() && (entry.name === "package.json" || /^tsconfig(?:\.[^/]+)?\.json$/.test(entry.name))) {
        found.push(path.relative(root, absolute).replace(/\\/g, "/"));
        if (found.length > 128) return false;
      }
    }
    return true;
  };
  return walk(root, 0) ? found.sort() : null;
}

/**
 * Files which define a discovered verifier. A passing summary is candidate-controlled output, so it can only
 * contribute to an independent judgement when the command definition that produced it is unchanged. The bounded
 * list covers the repository's supported verifier entry points and local scripts named by their configuration.
 * Unknown verifier commands fail closed rather than treating their output as independently authenticated.
 */
export function snapshotVerifierDefinition(
  workspace: string,
  command: string,
  trustedDeliverables: readonly string[] = [],
): Map<string, string> | null {
  const root = path.resolve(workspace);
  const baselineProductFiles = workspaceRuntimeFiles(root);
  const trustedSet = new Set(trustedDeliverables);
  const files = new Set<string>();
  const absentPaths = new Set<string>();
  const add = (relative: string) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) return false;
    try {
      const linkStat = fs.lstatSync(absolute);
      const real = fs.realpathSync(absolute);
      if (linkStat.isSymbolicLink() || !real.startsWith(`${root}${path.sep}`))
        return false;
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_TEST_BYTES) return false;
      files.add(path.relative(root, absolute));
      return true;
    } catch {
      return false;
    }
  };
  const scanReferences = (text: string, base: string, pending: string[]) => {
    const pattern =
      /(?:^|[\s"'=])((?:\.\.?\/|[\w.-]+\/)[\w./@+-]+|[\w.@+-]+\.(?:mjs|cjs|js|ts|tsx|sh|bash|py|ps1))(?=$|[\s"'*])/gm;
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].replace(/^\.\//, "");
      const resolved = path.resolve(base, candidate);
      if (!resolved.startsWith(`${root}${path.sep}`)) return false;
      if (fs.existsSync(resolved)) pending.push(resolved);
      else absentPaths.add(path.relative(root, resolved));
    }
    return true;
  };
  const addScriptReferences = (text: string, base = root) => {
    const pending: string[] = [];
    const baselineTestFiles = new Set(
      workspaceTestFiles(root).map((file) =>
        path.relative(root, file).replace(/\\/g, "/"),
      ),
    );
    if (!scanReferences(text, base, pending)) return false;
    // Bare script arguments are paths to Node/Python/shell interpreters even
    // without a slash or extension (`node verify`, `sh ci-check`). Bind or
    // absence-track only arguments in this interpreter position; arbitrary
    // bare command names remain operator/system command resolution.
    const interpreterScript =
      /(?:^|[\s;&|])(?:node|python\d?(?:\.\d+)?|bash|sh)\s+([^\s;&|]+)/g;
    for (const match of text.matchAll(interpreterScript)) {
      const script = match[1].replace(/^["']|["']$/g, "");
      if (script.startsWith("-")) continue;
      const resolved = path.resolve(base, script);
      if (!resolved.startsWith(`${root}${path.sep}`)) return false;
      if (fs.existsSync(resolved)) pending.push(resolved);
      else absentPaths.add(path.relative(root, resolved));
    }
    const visited = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (baselineTestFiles.has(relative)) {
        // Test bodies are captured separately for fail-before/pass-after
        // adjudication. Following their product imports here would bind the
        // implementation under test as part of the verifier definition and
        // reject every legitimate product edit as verifier drift.
        files.add(
          "\0test-file-set:" + JSON.stringify([...baselineTestFiles].sort()),
        );
        continue;
      }
      if (visited.size > 128 || !add(path.relative(root, file))) return false;
      const contents = fs.readFileSync(file, "utf8");
      if (!scanReferences(contents, path.dirname(file), pending)) return false;
    }
    return true;
  };
  const addLocalDependencyBoundaries = (start: string) => {
    for (
      let current = path.resolve(start);
      current.startsWith(root);
      current = path.dirname(current)
    ) {
      const dependencies = path.join(current, "node_modules");
      if (fs.existsSync(dependencies)) return false;
      absentPaths.add(path.relative(root, dependencies));
      if (current === root) break;
    }
    return true;
  };
  const addTestSupportDependencies = (testFile: string): boolean => {
    const pending = [testFile];
    const visited = new Set<string>();
    const extensions = [
      "",
      ".js",
      ".cjs",
      ".mjs",
      ".ts",
      ".tsx",
      ".jsx",
      ".json",
    ];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (visited.size > 256) return false;
      let text: string;
      try {
        text = fs.readFileSync(current, "utf8");
      } catch {
        return false;
      }
      const specifiers = new Set<string>();
      const importPattern =
        /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/gm;
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith(".")) specifiers.add(specifier);
      }
      for (const specifier of specifiers) {
        const base = path.resolve(path.dirname(current), specifier);
        if (!base.startsWith(`${root}${path.sep}`)) return false;
        const candidates = new Set<string>();
        if (/\.(?:c|m)?js$/.test(base)) {
          candidates.add(base.replace(/\.(?:c|m)?js$/, ".ts"));
          candidates.add(base.replace(/\.(?:c|m)?js$/, ".tsx"));
        }
        for (const extension of extensions) {
          candidates.add(base + extension);
          for (const indexExtension of extensions.slice(1)) {
            candidates.add(
              path.join(base + extension, `index${indexExtension}`),
            );
          }
        }
        const existing = [...candidates].filter((candidate) => {
          try {
            return fs.statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
        const supportRelative = path.relative(root, base);
        const normalizedSupport = supportRelative.replace(/\\/g, "/");
        const supportReference = trustedSet.size > 0
          ? !trustedSet.has(normalizedSupport)
          : !baselineProductFiles.has(normalizedSupport);
        if (existing.length === 0) {
          if (supportReference) {
            absentPaths.add(path.relative(root, base));
          }
          continue;
        }
        if (existing.length > 1) return false;
        const dependency = existing[0];
        const relative = path.relative(root, dependency);
        const normalizedDependency = relative.replace(/\\/g, "/");
        if (trustedSet.size > 0
          ? trustedSet.has(normalizedDependency)
          : baselineProductFiles.has(normalizedDependency)) continue;
        if (!add(relative)) return false;
        pending.push(dependency);
      }
    }
    return true;
  };
  const addNpmDefinition = (prefix?: string): boolean => {
    const packageFile = path.join(prefix ?? ".", "package.json");
    if (!add(packageFile)) return false;
    const packageRoot = path.resolve(root, path.dirname(packageFile));
    // A lockfile describes intended packages, not the bytes in mutable node_modules. Until a trusted immutable
    // dependency runner is available, local npm dependencies cannot establish independent verification.
    // Bind their absence too, so a candidate cannot add a fake .bin launcher after the baseline.
    if (!addLocalDependencyBoundaries(packageRoot)) return false;
    const npmrc = path.join(path.dirname(packageFile), ".npmrc");
    if (fs.existsSync(path.join(root, npmrc))) {
      const npmrcPath = path.resolve(root, npmrc);
      if (!npmrcPath.startsWith(`${root}${path.sep}`)) return false;
      let npmrcContents: string;
      try {
        const stat = fs.lstatSync(npmrcPath);
        const real = fs.realpathSync(npmrcPath);
        if (
          stat.isSymbolicLink() ||
          !real.startsWith(`${root}${path.sep}`) ||
          !stat.isFile() ||
          stat.size > MAX_TEST_BYTES
        ) return false;
        npmrcContents = fs.readFileSync(npmrcPath, "utf8");
      } catch {
        return false;
      }
      // npm auth values may be short, unquoted, and therefore invisible to the
      // generic entropy and assignment redactors. Never copy a credential-bearing
      // npmrc into durable verifier state; the caller will fail closed because
      // this verifier definition cannot be safely bound.
      if (/\b(?:_auth(?:token)?|_password|password|username)\s*(?:=|:)/i.test(npmrcContents)) {
        return false;
      }
      if (!add(npmrc)) return false;
    } else {
      absentPaths.add(npmrc);
    }
    let testScript: unknown;
    try {
      testScript = JSON.parse(
        fs.readFileSync(path.join(root, packageFile), "utf8"),
      )?.scripts?.test;
    } catch {
      return false;
    }
    if (typeof testScript !== "string" || !testScript.trim()) return false;
    if (
      !addScriptReferences(
        testScript,
        path.resolve(root, path.dirname(packageFile)),
      )
    )
      return false;
    for (const lock of [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]) {
      const rel = path.join(path.dirname(packageFile), lock);
      if (fs.existsSync(path.join(root, rel)) && !add(rel)) return false;
    }
    return true;
  };
  const addNpmInvocations = (text: string): boolean => {
    const pattern =
      /\b(?:npm|pnpm|yarn)(?:\s+(?:--prefix|--dir)(?:=|\s+)([^\s]+))?\s+(?:(?:run|run-script)\s+)?test\b/g;
    for (const match of text.matchAll(pattern)) {
      // The package script is common to the supported package managers. Its
      // dependency tree is separately required to remain absent or immutable.
      if (!addNpmDefinition(match[1])) return false;
    }
    return true;
  };

  if (/^npm(?:\s|$)/.test(command)) {
    const prefix = command.match(/--(?:prefix|dir)(?:=|\s+)([^\s]+)/)?.[1];
    if (!addNpmDefinition(prefix)) return null;
    const runtimeDefinitions = runtimeDefinitionFiles(root);
    if (!runtimeDefinitions) return null;
    for (const relative of runtimeDefinitions) if (!add(relative)) return null;
    files.add("\0runtime-definition-set:" + JSON.stringify(runtimeDefinitions));
    files.add(
      "\0runtime-product-set:" +
        JSON.stringify([...baselineProductFiles].sort()),
    );
  } else if (/^make\s+test(?:\s|$)/.test(command)) {
    const pending = ["Makefile"];
    const seen = new Set<string>();
    let targetFound = false;
    while (pending.length) {
      const rel = pending.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (seen.size > 64 || !add(rel)) return null;
      const makefile = fs.readFileSync(path.join(root, rel), "utf8");
      if (/^test:/m.test(makefile)) targetFound = true;
      for (const line of makefile.split(/\r?\n/)) {
        const include = line.match(/^\s*(?:-?include|sinclude)\s+(.+)$/);
        if (!include) continue;
        const names = include[1].trim().split(/\s+/);
        // Variable expansion and globs have make semantics this bounded resolver does not emulate.
        if (!names.length || names.some((name) => /[$*?%]/.test(name)))
          return null;
        for (const name of names) {
          const resolved = path.resolve(root, path.dirname(rel), name);
          if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved))
            return null;
          pending.push(path.relative(root, resolved));
        }
      }
      if (
        !addScriptReferences(makefile, path.resolve(root, path.dirname(rel))) ||
        !addNpmInvocations(makefile)
      )
        return null;
    }
    if (!targetFound) return null;
  } else if (/^cargo\s+test(?:\s|$)/.test(command)) {
    const manifest =
      command.match(/--manifest-path\s+([^\s]+)/)?.[1] ?? "Cargo.toml";
    if (!add(manifest)) return null;
    for (const rel of [
      "Cargo.lock",
      path.join(path.dirname(manifest), "Cargo.lock"),
      ".cargo/config",
      ".cargo/config.toml",
    ]) {
      if (fs.existsSync(path.join(root, rel)) && !add(rel)) return null;
    }
  } else if (
    /^(?:pytest|python\d?(?:\.\d+)?\s+-m\s+pytest)(?:\s|$)/.test(command)
  ) {
    const configs = ["pytest.ini", "pyproject.toml", "setup.cfg", "setup.py"];
    const present = configs.filter((rel) =>
      fs.existsSync(path.join(root, rel)),
    );
    if (!present.length) return null;
    for (const rel of present) if (!add(rel)) return null;
    if (
      !addScriptReferences(
        present
          .map((rel) => fs.readFileSync(path.join(root, rel), "utf8"))
          .join("\n"),
      )
    )
      return null;
  } else if (/^go\s+test(?:\s|$)/.test(command)) {
    if (!add("go.mod")) return null;
    for (const rel of ["go.sum", "vendor/modules.txt"]) {
      if (fs.existsSync(path.join(root, rel)) && !add(rel)) return null;
    }
  } else if (
    /^(?:env\s+-u\s+NODE_TEST_CONTEXT\s+)?node\s+--test(?:\s+\S.*)?$/.test(
      command,
    )
  ) {
    // The accepted nested Node test runner used by the harness. Bind every
    // discovered test file; other wrappers remain unprovable and fail closed.
    const tests = snapshotTests(root);
    if (!tests || tests.size === 0) return null;
    // Test source is separately snapshotted in ChangeBaseline so changed tests
    // can be set aside and the original suite rerun against the code. The
    // verifier-definition boundary binds test membership, not mutable bodies.
    files.add("\0test-file-set:" + JSON.stringify([...tests.keys()].sort()));
  } else {
    const script = command.match(
      /^(?:node|python\d?(?:\.\d+)?|bash|sh)\s+([^\s]+)(?:\s|$)/,
    )?.[1];
    if (!script || script.startsWith("-")) return null;
    const relative = path.isAbsolute(script)
      ? path.relative(root, script)
      : script;
    if (!add(relative)) return null;
    if (/^(?:node)(?:\s|$)/.test(command.trim())) {
      if (
        !addLocalDependencyBoundaries(
          path.dirname(path.resolve(root, relative)),
        )
      )
        return null;
    }
    if (
      !addScriptReferences(fs.readFileSync(path.join(root, relative), "utf8"))
    )
      return null;
  }

  // Capture the product graph for every supported workspace verifier, not only
  // npm scripts. Operator-configured `node --test` and direct-script commands
  // need the same pre-change source boundary for import-based deliverable proof.
  if (![...files].some((file) => file.startsWith("\0runtime-definition-set:"))) {
    const runtimeDefinitions = runtimeDefinitionFiles(root);
    if (!runtimeDefinitions) return null;
    for (const relative of runtimeDefinitions) if (!add(relative)) return null;
    files.add("\0runtime-definition-set:" + JSON.stringify(runtimeDefinitions));
  }
  if (![...files].some((file) => file.startsWith("\0runtime-product-set:"))) {
    files.add(
      "\0runtime-product-set:" +
        JSON.stringify([...baselineProductFiles].sort()),
    );
  }

  // Snapshot test imports that are not an explicitly scoped deliverable. This
  // includes dual-use assertion modules even when runtime-reachable; only the
  // operator-declared output paths are allowed to change without invalidating
  // the test oracle boundary.
  for (const testFile of workspaceTestFiles(root)) {
    if (!addTestSupportDependencies(testFile)) return null;
  }

  const snapshot = new Map<string, string>();
  for (const rel of files) {
    if (rel.startsWith("\0test-file-set:")) {
      snapshot.set(rel, "");
      continue;
    }
    if (rel.startsWith("\0runtime-definition-set:")) {
      snapshot.set(rel, "");
      continue;
    }
    if (rel.startsWith("\0runtime-product-set:")) {
      snapshot.set(rel, "");
      continue;
    }
    snapshot.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
  }
  for (const rel of absentPaths)
    snapshot.set("\0must-remain-absent:" + rel, "");
  return snapshot;
}

/** Whether the verifier's configured command, dependencies, or local entry script changed after its baseline. */
export function verifierDefinitionChangedSince(
  workspace: string,
  baseline: ChangeBaseline,
): boolean {
  if (!baseline.verifier || baseline.verifier.size === 0) return true;
  const root = path.resolve(workspace);
  for (const [relative, content] of baseline.verifier) {
    if (relative.startsWith("\0test-file-set:")) {
      // Test bodies and membership may change; their turn-start bytes are
      // captured separately and restored for the independent baseline run.
      continue;
    }
    if (relative.startsWith("\0runtime-definition-set:")) {
      const current = runtimeDefinitionFiles(root);
      if (!current || JSON.stringify(current) !== relative.slice("\0runtime-definition-set:".length)) return true;
      continue;
    }
    // Preserve the turn-start runtime graph as classification authority. Source
    // edits may add valid runtime dependencies, but cannot promote test support
    // into a deliverable during the same verification attempt.
    if (relative.startsWith("\0runtime-product-set:")) continue;
    if (relative.startsWith("\0must-remain-absent:")) {
      const target = path.resolve(
        root,
        relative.slice("\0must-remain-absent:".length),
      );
      if (!target.startsWith(root + path.sep) || fs.existsSync(target))
        return true;
      continue;
    }
    if (relative.startsWith("\0runtime-definition-set:")) continue;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) return true;
    try {
      const stat = fs.lstatSync(absolute);
      const real = fs.realpathSync(absolute);
      if (
        stat.isSymbolicLink() ||
        !real.startsWith(`${root}${path.sep}`) ||
        !stat.isFile() ||
        fs.readFileSync(absolute, "utf8") !== content
      )
        return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** A new workspace-local npm dependency tree changes executable resolution after the baseline. */
export function npmDependencyBoundaryChangedSince(
  workspace: string,
  baseline: ChangeBaseline,
): boolean {
  if (!baseline.verifier) return true;
  const root = path.resolve(workspace);
  return [...baseline.verifier.keys()].some((key) => {
    if (!key.startsWith("\0must-remain-absent:")) return false;
    const relative = key.slice("\0must-remain-absent:".length);
    if (path.basename(relative) !== "node_modules") return false;
    return fs.existsSync(path.resolve(root, relative));
  });
}

/** Whether any test file was added, removed or changed since the baseline. */
export function testsChangedSince(
  workspace: string,
  baseline: Map<string, string>,
): boolean {
  const now = snapshotTests(workspace);
  if (!now || now.size !== baseline.size) return true;
  for (const [file, content] of now)
    if (baseline.get(file) !== content) return true;
  return false;
}

/** What a passing, deliverable-covering run of `command` shows, given the baseline (no extra run needed). */
export function judgeWithoutCopy(
  workspace: string,
  command: string,
  baseline: ChangeBaseline | null | undefined,
): Independence | "needs-copy" {
  if (!baseline || baseline.command !== command) {
    return {
      independent: false,
      detail: `no run of ${command} before this change was recorded, so nothing shows the tests exercise the change`,
    };
  }
  const verifierChanged = verifierDefinitionChangedSince(workspace, baseline);
  if (!baseline.verifier || baseline.verifier.size === 0) {
    return {
      independent: false,
      detail:
        "the pre-change verifier definition was not captured, so its test summary cannot establish independent evidence",
    };
  }
  const changed =
    !baseline.tests || testsChangedSince(workspace, baseline.tests);
  if (!baseline.failed) {
    return {
      independent: false,
      detail: changed
        ? "the existing tests passed before the change too; the new behaviour is checked only by tests Nexus wrote"
        : "the existing tests passed before the change too, so they do not show the change",
    };
  }
  if (npmDependencyBoundaryChangedSince(workspace, baseline)) {
    return {
      independent: false,
      detail:
        "a workspace-local npm dependency tree appeared after the baseline; its executable and package contents are not independently bound",
    };
  }
  if (!changed && !verifierChanged)
    return {
      independent: true,
      detail: "tests that failed before the change pass after it",
    };
  if (!baseline.tests)
    return {
      independent: false,
      detail:
        "Nexus changed test files that were too large to set aside, so its own test edits cannot be excluded",
    };
  return "needs-copy";
}

const MAX_COPY_FILES = 20_000;

/**
 * A copy of the workspace (dependency and build directories linked, not copied) with the test files as they were at
 * the baseline: tests the change added are removed, tests it edited are restored. Under `.nexus/verify/`, so it stays
 * inside the workspace's sandbox. Returns null when the workspace is too large to copy.
 */
export function prepareBaselineTestsCopy(
  workspace: string,
  tests: Map<string, string>,
  verifier: Map<string, string>,
): string | null {
  const root = path.resolve(workspace);
  const dir = path.join(root, ".nexus", "verify", randomUUID());
  let files = 0;
  const copy = (from: string, to: string): boolean => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (from === root && entry.name === ".nexus") continue;
      if (
        entry.isDirectory() &&
        SKIP_DIRS.has(entry.name) &&
        entry.name !== ".git"
      ) {
        fs.symlinkSync(src, dst, "dir");
      } else if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (!copy(src, dst)) return false;
      } else if (entry.isSymbolicLink()) {
        let realTarget: string;
        let targetIsDirectory: boolean;
        try {
          realTarget = fs.realpathSync(src);
          targetIsDirectory = fs.statSync(src).isDirectory();
        } catch {
          return false;
        }
        const relativeTarget = path.relative(root, realTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        )
          return false;
        if (++files > MAX_COPY_FILES) return false;
        const linkTarget = fs.readlinkSync(src);
        const rebasedTarget = path.isAbsolute(linkTarget)
          ? path.join(dir, path.relative(root, realTarget))
          : linkTarget;
        fs.symlinkSync(rebasedTarget, dst, targetIsDirectory ? "dir" : "file");
      } else if (entry.isFile()) {
        if (++files > MAX_COPY_FILES) return false;
        fs.copyFileSync(src, dst);
      }
    }
    return true;
  };
  try {
    if (!copy(root, dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    }
    for (const file of workspaceTestFiles(dir)) {
      if (!tests.has(path.relative(dir, file)))
        fs.rmSync(file, { force: true });
    }
    for (const [rel, content] of tests) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    for (const [rel, content] of verifier) {
    if (
      rel.startsWith("\0runtime-definition-set:") ||
      rel.startsWith("\0runtime-product-set:")
    ) continue;
      if (rel.startsWith("\0must-remain-absent:")) {
        const absent = rel.slice("\0must-remain-absent:".length);
        const destination = path.resolve(dir, absent);
        if (!destination.startsWith(dir + path.sep))
          throw new Error("verifier absence path escaped workspace");
        if (
          path.basename(absent) === "node_modules" &&
          fs.existsSync(destination)
        )
          throw new Error("mutable npm dependencies appeared after baseline");
        fs.rmSync(destination, { recursive: true, force: true });
        continue;
      }
      const destination = path.resolve(dir, rel);
      if (!destination.startsWith(`${dir}${path.sep}`))
        throw new Error("verifier path escaped workspace");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    return dir;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}
