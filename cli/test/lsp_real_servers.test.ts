// Real language servers (CS-6). The v1.2.0 LSP support (lsp.ts) is otherwise tested only against test/fixtures/fake_lsp_server.mjs.
// Here the product's own LspBridgeManager starts the real server, found the way the product finds it (the default
// extension -> command table, resolved on the scrubbed PATH buildLspEnvironment returns), on a tiny fixture project:
//   - a file with one deliberate error must yield status "ok" with an error diagnostic naming it;
//   - a clean file must yield status "ok" with an EMPTY list (a real report), which is not "unavailable";
//   - a manager whose server cannot start must yield "unavailable" (the contrast the two above are read against).
// A server that is not installed SKIPS with its reason, unless NEXUS_LSP_REQUIRE names it ("1" or "all" = every server,
// or a comma list such as "typescript,python"), in which case its absence is a failure. The scheduled workflow
// .github/workflows/lsp-real-servers.yml sets it. The availability probe runs with the SAME environment the product
// gives the server (buildLspEnvironment), so a tool visible only to the shell (a `pip install --user` under another HOME)
// is reported missing instead of passing the probe and failing later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LspBridgeManager, buildLspEnvironment } from "../src/lsp.js";

interface Case {
  /** Why this case is not yet validated on a real run; it then reports as a todo unless NEXUS_LSP_REQUIRE names it. */
  unvalidated?: string;
  id: string;
  label: string;
  cmd: string;
  /** Run to prove the binary works (exit 0); null when the server has no such mode and the PATH lookup must do. */
  probe: string[] | null;
  files: Record<string, string>;
  bad: string;
  clean: string;
  /** Matches the message of the deliberate error. */
  message: RegExp;
  timeoutMs: number;
}

const CASES: Case[] = [
  {
    id: "typescript",
    label: "typescript-language-server",
    cmd: "typescript-language-server",
    probe: ["--version"],
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext" }, include: ["*.ts"] }),
      "bad.ts": 'export const n: number = "not a number";\n',
      "clean.ts": "export const ok: number = 1;\n",
    },
    bad: "bad.ts",
    clean: "clean.ts",
    message: /string.*not assignable.*number|not assignable/i,
    timeoutMs: 60_000,
  },
  {
    id: "python",
    label: "pyright-langserver",
    cmd: "pyright-langserver",
    probe: null,
    files: {
      "pyrightconfig.json": JSON.stringify({ typeCheckingMode: "basic" }),
      "bad.py": 'x: int = "not an int"\n',
      "clean.py": "x: int = 1\n",
    },
    bad: "bad.py",
    clean: "clean.py",
    message: /str.*not assignable.*int|not assignable/i,
    timeoutMs: 60_000,
  },
  {
    id: "rust",
    label: "rust-analyzer",
    cmd: "rust-analyzer",
    probe: ["--version"],
    files: {
      "Cargo.toml": '[package]\nname = "lspfixture"\nversion = "0.0.0"\nedition = "2021"\n',
      "src/main.rs": 'fn main() {\n    let x: i32 = "not an int";\n    let _ = x;\n}\n',
      "src/clean.rs": "pub fn ok() -> i32 {\n    1\n}\n",
    },
    bad: "src/main.rs",
    clean: "src/clean.rs",
    message: /mismatched types|expected i32/i,
    timeoutMs: 120_000,
  },
  {
    id: "go",
    label: "gopls",
    cmd: "gopls",
    probe: ["version"],
    files: {
      "go.mod": "module lspfixture\n\ngo 1.21\n",
      "bad.go": 'package main\n\nfunc main() {\n\tvar x int = "not an int"\n\t_ = x\n}\n',
      "clean.go": "package main\n\nfunc ok() int {\n\treturn 1\n}\n",
    },
    bad: "bad.go",
    clean: "clean.go",
    message: /cannot use|string.*int/i,
    timeoutMs: 90_000,
  },
];

function required(id: string): boolean {
  const v = (process.env.NEXUS_LSP_REQUIRE ?? "").trim().toLowerCase();
  if (v === "") return false;
  if (v === "1" || v === "all" || v === "true") return true;
  return v.split(",").map((s) => s.trim()).includes(id);
}

/** Where the product would find `cmd`: the first executable on the PATH it gives a language server for `workspace`. */
function resolveOnProductPath(cmd: string, workspace: string): { bin: string | null; env: Record<string, string> } {
  const env = buildLspEnvironment(workspace);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return { bin: candidate, env };
    } catch {
      /* next entry */
    }
  }
  return { bin: null, env };
}

/** null when usable; otherwise the reason it is not. */
function unavailableReason(c: Case, workspace: string): string | null {
  const { bin, env } = resolveOnProductPath(c.cmd, workspace);
  if (!bin) return `${c.cmd} is not on the PATH the product gives a language server`;
  if (c.probe) {
    // In the fixture directory, as the product launches the server: a rustup proxy picks its toolchain from the working directory (a repo's rust-toolchain.toml would hide a missing default component).
    const r = spawnSync(bin, c.probe, { env, cwd: workspace, encoding: "utf-8", timeout: 20_000 });
    if (r.status !== 0) {
      const why = (r.stderr || r.error?.message || `exit ${r.status}`).toString().trim().split("\n")[0];
      return `${c.cmd} ${c.probe.join(" ")} failed under the product environment (${why})`;
    }
  }
  return null;
}

function writeFixture(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-real-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

for (const c of CASES) {
  // An unvalidated case still runs and reports; it fails the run only when NEXUS_LSP_REQUIRE names it.
  const todo = c.unvalidated && !required(c.id) ? c.unvalidated : false;
  test(`real ${c.label}: a deliberate error is reported, a clean file is a real empty report`, { timeout: c.timeoutMs * 2 + 30_000, todo }, async (t) => {
    const dir = writeFixture(c.files);
    const reason = unavailableReason(c, dir);
    if (reason) {
      if (required(c.id)) assert.fail(`NEXUS_LSP_REQUIRE names ${c.id} but ${reason}`);
      t.skip(`${reason}; install it to run this case (CI sets NEXUS_LSP_REQUIRE to make this a failure)`);
      return;
    }
    // Default server table (no `servers` override) and no gate: a trusted, unsandboxed workspace.
    const mgr = new LspBridgeManager(dir, { gate: () => null });
    try {
      const bad = await mgr.diagnostics(c.bad, c.timeoutMs);
      assert.equal(bad.status, "ok", `bad file: ${JSON.stringify(bad)}`);
      if (bad.status === "ok") {
        const errors = bad.diagnostics.filter((d) => d.severity === "error");
        assert.ok(errors.length >= 1, `expected an error diagnostic, got ${JSON.stringify(bad.diagnostics)}`);
        assert.ok(errors.some((d) => c.message.test(d.message)), `no error matched ${c.message}: ${JSON.stringify(errors.map((d) => d.message))}`);
      }

      const clean = await mgr.diagnostics(c.clean, c.timeoutMs);
      assert.equal(clean.status, "ok", `clean file must be a published report, not unavailable: ${JSON.stringify(clean)}`);
      if (clean.status === "ok") assert.deepEqual(clean.diagnostics.filter((d) => d.severity === "error"), []);
    } finally {
      mgr.shutdownAll();
    }

    // The contrast: no server for the file's content is "unavailable", never an empty ok report.
    const broken = new LspBridgeManager(dir, { servers: { [path.extname(c.clean)]: { cmd: "nexus-no-such-language-server", languageId: c.id } } });
    try {
      const res = await broken.diagnostics(c.clean, 1000);
      assert.equal(res.status, "unavailable");
    } finally {
      broken.shutdownAll();
    }
  });
}

test("a server named by NEXUS_LSP_REQUIRE that is absent fails; an unnamed absent one skips", () => {
  const saved = process.env.NEXUS_LSP_REQUIRE;
  try {
    process.env.NEXUS_LSP_REQUIRE = "typescript, go";
    assert.deepEqual(CASES.map((c) => required(c.id)), [true, false, false, true]);
    process.env.NEXUS_LSP_REQUIRE = "1";
    assert.ok(CASES.every((c) => required(c.id)));
    delete process.env.NEXUS_LSP_REQUIRE;
    assert.ok(CASES.every((c) => !required(c.id)));
  } finally {
    if (saved === undefined) delete process.env.NEXUS_LSP_REQUIRE; else process.env.NEXUS_LSP_REQUIRE = saved;
  }
  const d = writeFixture({});
  const ghost: Case = { ...CASES[0], cmd: "nexus-no-such-language-server" };
  assert.match(unavailableReason(ghost, d) ?? "", /not on the PATH/);
});

test("the default servers for typescript and python are launched with --stdio (they exit without it)", () => {
  const dir = writeFixture({});
  const mgr = new LspBridgeManager(dir);
  try {
    for (const f of ["a.ts", "a.tsx", "a.js", "a.py"]) assert.deepEqual(mgr.getServerForFile(f)?.args, ["--stdio"], f);
    for (const f of ["a.rs", "a.go"]) assert.equal(mgr.getServerForFile(f)?.args, undefined, f);
  } finally {
    mgr.shutdownAll();
  }
});
