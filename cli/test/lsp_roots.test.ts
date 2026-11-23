/**
 * Unit LS-2, project roots: a server is started for the nearest directory inside the workspace that holds a marker of
 * its language (src/lsp_roots.ts), one process per server and root, at most LSP_MAX_SERVERS of them. The rules are
 * checked on the product's own server table without starting anything; the processes, their `rootUri` and
 * `workspaceFolders`, the cap and the shutdown are checked against the scripted fake, by pid.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { LSP_LIMITS, LSP_MAX_SERVERS, LspBridgeManager } from "../src/lsp.js";
import { findProjectRoot } from "../src/lsp_roots.js";
import { alive, eventually, hoverBody, open } from "./helpers/lsp_scripted.js";

/** A throwaway directory tree: a name ending in "/" is a directory, `{ link }` a symlink to that target. */
function tree(files: Record<string, string | { link: string }>): { root: string; ws: string; remove: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-roots-")));
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  for (const [name, content] of Object.entries(files)) {
    const at = path.resolve(ws, name);
    fs.mkdirSync(name.endsWith("/") ? at : path.dirname(at), { recursive: true });
    if (typeof content !== "string") fs.symlinkSync(path.resolve(ws, content.link), at);
    else if (!name.endsWith("/")) fs.writeFileSync(at, content);
  }
  return { root, ws, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The roots the product's own table gives, without starting a server. */
function roots(ws: string, files: string[]): Record<string, string | null> {
  const mgr = new LspBridgeManager(ws);
  try {
    return Object.fromEntries(files.map((f) => [f, mgr.rootFor(f)]));
  } finally {
    void mgr.shutdownAll(); // nothing was started
  }
}

// ------------------------------------------------------------------------------------------------- the rules, pure

test("typescript and javascript: the nearest directory with tsconfig.json, jsconfig.json or package.json; the workspace when there is none", () => {
  const t = tree({
    "web/tsconfig.json": "{}",
    "web/src/deep/x.ts": "",
    "web/pkg/package.json": "{}",
    "web/pkg/lib/y.tsx": "",
    "tools/jsconfig.json": "{}",
    "tools/z.js": "",
    "loose/w.ts": "",
    "top.jsx": "",
  });
  try {
    assert.deepEqual(roots(t.ws, ["web/src/deep/x.ts", "web/pkg/lib/y.tsx", "tools/z.js", "loose/w.ts", "top.jsx"]), {
      "web/src/deep/x.ts": "web",
      "web/pkg/lib/y.tsx": "web/pkg",
      "tools/z.js": "tools",
      "loose/w.ts": ".",
      "top.jsx": ".",
    });
  } finally {
    t.remove();
  }
});

test("python: the nearest directory with pyproject.toml, setup.py, setup.cfg or pyrightconfig.json", () => {
  const t = tree({ "a/pyproject.toml": "", "a/app/m.py": "", "b/setup.py": "", "b/m.py": "", "c/setup.cfg": "", "c/m.py": "", "d/pyrightconfig.json": "{}", "d/x/y/m.py": "", "e/m.py": "" });
  try {
    assert.deepEqual(roots(t.ws, ["a/app/m.py", "b/m.py", "c/m.py", "d/x/y/m.py", "e/m.py"]), { "a/app/m.py": "a", "b/m.py": "b", "c/m.py": "c", "d/x/y/m.py": "d", "e/m.py": "." });
  } finally {
    t.remove();
  }
});

test("rust: the nearest Cargo.toml, or the Cargo workspace above it when a parent declares [workspace]; a parent that declares none does not take a package over", () => {
  const pkg = (name: string) => `[package]\nname = "${name}"\nversion = "0.0.0"\n`;
  const t = tree({
    "crates/Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n',
    "crates/a/Cargo.toml": pkg("a"),
    "crates/a/src/lib.rs": "",
    "crates/b/Cargo.toml": pkg("b"),
    "crates/b/src/deep/mod.rs": "",
    "solo/Cargo.toml": pkg("solo"),
    "solo/src/main.rs": "",
    // A package with another package below it and no workspace: the inner one is its own project.
    "outer/Cargo.toml": `${pkg("outer")}\n# [workspace] in a comment declares nothing\n`,
    "outer/inner/Cargo.toml": pkg("inner"),
    "outer/inner/src/lib.rs": "",
    // The table can be declared by a sub-table alone, and a root package can be the workspace itself.
    "shared/Cargo.toml": `${pkg("shared")}\n  [workspace.package]\nedition = "2021"\n`,
    "shared/member/Cargo.toml": pkg("member"),
    "shared/member/src/lib.rs": "",
    "shared/src/lib.rs": "",
    "none/src/lib.rs": "",
  });
  try {
    assert.deepEqual(roots(t.ws, ["crates/a/src/lib.rs", "crates/b/src/deep/mod.rs", "solo/src/main.rs", "outer/inner/src/lib.rs", "shared/member/src/lib.rs", "shared/src/lib.rs", "none/src/lib.rs"]), {
      "crates/a/src/lib.rs": "crates",
      "crates/b/src/deep/mod.rs": "crates",
      "solo/src/main.rs": "solo",
      "outer/inner/src/lib.rs": "outer/inner",
      "shared/member/src/lib.rs": "shared",
      "shared/src/lib.rs": "shared",
      "none/src/lib.rs": ".",
    });
  } finally {
    t.remove();
  }
});

test("go: a go.work above the file wins over a nearer go.mod; without one, the nearest go.mod", () => {
  const t = tree({ "mono/go.work": "go 1.21\nuse ./svc\n", "mono/svc/go.mod": "module svc\n", "mono/svc/cmd/main.go": "", "plain/go.mod": "module plain\n", "plain/internal/x/x.go": "", "plain/nested/go.mod": "module nested\n", "plain/nested/n.go": "", "bare/b.go": "" });
  try {
    assert.deepEqual(roots(t.ws, ["mono/svc/cmd/main.go", "plain/internal/x/x.go", "plain/nested/n.go", "bare/b.go"]), { "mono/svc/cmd/main.go": "mono", "plain/internal/x/x.go": "plain", "plain/nested/n.go": "plain/nested", "bare/b.go": "." });
  } finally {
    t.remove();
  }
});

test("a root is never outside the workspace: a marker above it, a marker that is a symlink to a file outside it, and a directory linked in from outside are not used", () => {
  const t = tree({
    "../tsconfig.json": "{}", // above the workspace
    "../outside/tsconfig.json": "{}",
    "../outside/pkg/f.ts": "",
    "plain.ts": "",
    // The only marker here is a link to the manifest outside.
    "linked/tsconfig.json": { link: "../outside/tsconfig.json" },
    "linked/x.ts": "",
    // A link to a manifest inside the workspace is a marker like any other.
    "real/tsconfig.json": "{}",
    "inlink/tsconfig.json": { link: "real/tsconfig.json" },
    "inlink/y.ts": "",
    // A directory named like a marker is not one.
    "dir/package.json/": "",
    "dir/z.ts": "",
    // A whole directory linked in from outside: its files are not the workspace's.
    "out": { link: "../outside" },
  });
  try {
    assert.equal(fs.existsSync(path.join(t.ws, "linked", "tsconfig.json")), true, "precondition: the linked marker resolves");
    assert.deepEqual(roots(t.ws, ["plain.ts", "linked/x.ts", "inlink/y.ts", "dir/z.ts", "out/pkg/f.ts", "no/such/file.ts", "../outside/pkg/f.ts"]), {
      "plain.ts": ".",
      "linked/x.ts": ".",
      "inlink/y.ts": "inlink",
      "dir/z.ts": ".",
      "out/pkg/f.ts": ".",
      "no/such/file.ts": ".",
      "../outside/pkg/f.ts": ".",
    });
    // The function itself: always the workspace as it was given, or a directory below it.
    const rule = { markers: [["tsconfig.json"]] };
    assert.equal(findProjectRoot(t.ws, "linked/x.ts", rule), t.ws);
    assert.equal(findProjectRoot(t.ws, "out/pkg/f.ts", rule), t.ws);
    assert.equal(findProjectRoot(t.ws, path.join(t.ws, "inlink/y.ts"), rule), path.join(t.ws, "inlink"), "an absolute path is taken too");
    assert.equal(findProjectRoot(t.ws, "inlink/y.ts", undefined), t.ws, "no rule: the workspace");
  } finally {
    t.remove();
  }
});

test("a workspace reached through a symlink: the root keeps the spelling the workspace was given, canonical below it", () => {
  const t = tree({ "pkg/tsconfig.json": "{}", "pkg/src/x.ts": "" });
  try {
    const link = path.join(t.root, "link");
    fs.symlinkSync(t.ws, link);
    assert.equal(findProjectRoot(link, "pkg/src/x.ts", { markers: [["tsconfig.json"]] }), path.join(link, "pkg"));
    assert.deepEqual(roots(link, ["pkg/src/x.ts"]), { "pkg/src/x.ts": "pkg" });
  } finally {
    t.remove();
  }
});

// --------------------------------------------------------------------------------------------- processes, by pid

const TS_RULE = { root: { markers: [["tsconfig.json"]] } };
const MONOREPO = { "pkg/a/tsconfig.json": "{}", "pkg/a/src/x.ts": "alpha\n", "pkg/b/tsconfig.json": "{}", "pkg/b/y.ts": "beta\n", "top.ts": "gamma\n", "a.ts": "x\n" };
const held = (res: { output: string }) => Object.keys(JSON.parse(hoverBody(res.output)).docs);

for (const viaSymlink of [false, true]) {
  test(`nested packages get separate servers, each with its package as rootUri and workspaceFolders; a file outside any package gets the workspace's${viaSymlink ? " (workspace reached through a symlink)" : ""}`, async () => {
    const s = open({ hover: "fromText", definition: { "x.ts": [{ uri: "$root/../b/y.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }] } }, MONOREPO, { spec: TS_RULE, viaSymlink });
    try {
      // Each server holds only the documents of its own project: three servers, not one.
      assert.deepEqual(held(await s.tool("lsp_hover", { path: "pkg/a/src/x.ts", line: 1, character: 1 })), ["x.ts"]);
      assert.deepEqual(held(await s.tool("lsp_hover", { path: "pkg/b/y.ts", line: 1, character: 1 })), ["y.ts"]);
      assert.deepEqual(held(await s.tool("lsp_hover", { path: "top.ts", line: 1, character: 1 })), ["top.ts"]);
      assert.deepEqual(held(await s.tool("lsp_hover", { path: "pkg/a/src/x.ts", line: 1, character: 1 })), ["x.ts"], "asked again: the same server");

      const servers = s.servers();
      assert.deepEqual(servers.map((x) => x.root).sort(), [".", "pkg/a", "pkg/b"]);
      assert.equal(new Set(servers.map((x) => x.pid)).size, 3, "three processes");
      assert.ok(servers.every((x) => alive(x.pid)));
      const uri = (dir: string) => pathToFileURL(path.join(s.ws, dir)).href;
      const initialized = (await s.received("initialize")).map((e) => [e.params.rootUri, e.params.workspaceFolders]);
      assert.deepEqual(initialized, [
        [uri("pkg/a"), [{ uri: uri("pkg/a"), name: "a" }]],
        [uri("pkg/b"), [{ uri: uri("pkg/b"), name: "b" }]],
        [pathToFileURL(s.ws).href, [{ uri: pathToFileURL(s.ws).href, name: path.basename(s.ws) }]],
      ]);
      assert.deepEqual((await s.received("textDocument/didOpen")).map((e) => e.params.textDocument.uri), [s.uri("pkg/a/src/x.ts"), s.uri("pkg/b/y.ts"), s.uri("top.ts")], "each document is named below its server's root");
      assert.deepEqual(["pkg/a/src/x.ts", "pkg/b/y.ts", "top.ts"].map((f) => [s.mgr.serverStatus(f)!.root, s.mgr.serverStatus(f)!.state]), [["pkg/a", "ready"], ["pkg/b", "ready"], [".", "ready"]]);
      assert.deepEqual(s.mgr.serverPids().sort(), servers.map((x) => x.pid).sort());

      // A target in another package is named from the workspace, as a query's input would name it, and is not "external".
      assert.deepEqual(JSON.parse((await s.tool("lsp_definition", { path: "pkg/a/src/x.ts", line: 1, character: 1 })).output), [{ file: "pkg/b/y.ts", line: 1, column: 1, endLine: 1, endColumn: 5 }]);

      await s.mgr.shutdownAll();
      assert.deepEqual(servers.filter((x) => alive(x.pid)), [], "shutdown ends every one of them");
      assert.deepEqual(s.mgr.serverPids(), []);
    } finally {
      await s.close();
    }
  });
}

test("a server whose spec names no markers runs for the workspace root, whatever project files lie between", async () => {
  const s = open({ hover: "fromText" }, MONOREPO);
  try {
    await s.tool("lsp_hover", { path: "pkg/a/src/x.ts", line: 1, character: 1 });
    assert.deepEqual(held(await s.tool("lsp_hover", { path: "pkg/b/y.ts", line: 1, character: 1 })), ["x.ts", "y.ts"], "one server holds both");
    assert.deepEqual(s.servers().map((x) => x.root), ["."]);
    assert.equal((await s.received("initialize"))[0].params.rootUri, pathToFileURL(s.ws).href);
  } finally {
    await s.close();
  }
});

test("a refusal by the gate stops the servers of every root; a marker that appears later moves a file to a server of its own", async () => {
  let refusal: string | null = null;
  const s = open({ hover: "fromText" }, MONOREPO, { spec: TS_RULE, gate: () => refusal });
  try {
    await s.tool("lsp_hover", { path: "pkg/a/src/x.ts", line: 1, character: 1 });
    await s.tool("lsp_hover", { path: "top.ts", line: 1, character: 1 });
    fs.mkdirSync(path.join(s.ws, "late"));
    fs.writeFileSync(path.join(s.ws, "late", "l.ts"), "delta\n");
    assert.deepEqual(held(await s.tool("lsp_hover", { path: "late/l.ts", line: 1, character: 1 })), ["top.ts", "l.ts"], "no marker: the workspace's server");
    fs.writeFileSync(path.join(s.ws, "late", "tsconfig.json"), "{}");
    assert.deepEqual(held(await s.tool("lsp_hover", { path: "late/l.ts", line: 1, character: 1 })), ["l.ts"], "its own project now");
    const before = s.servers();
    assert.deepEqual(before.map((x) => x.root), ["pkg/a", ".", "late"]);

    refusal = "workspace not trusted; language server not started";
    assert.deepEqual(await s.tool("lsp_hover", { path: "top.ts", line: 1, character: 1 }), { success: false, output: "No hover info", error: refusal });
    assert.deepEqual(s.mgr.serverPids(), []);
    await s.mgr.shutdownAll(); // waits for the stops the refusal began
    assert.deepEqual(before.filter((x) => alive(x.pid)), []);
    assert.deepEqual(s.mgr.serverStatus("pkg/a/src/x.ts"), { server: process.execPath, root: "pkg/a", state: "not_started", forMs: 0, detail: refusal });
  } finally {
    await s.close();
  }
});

test("a file reached through a directory linked in from outside the workspace starts no server", async () => {
  const s = open({ hover: "fromText" }, { "a.ts": "x\n" }, { spec: TS_RULE });
  try {
    const outside = path.join(s.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(outside, "f.ts"), "secret\n");
    fs.symlinkSync(outside, path.join(s.ws, "out"));
    assert.deepEqual(await s.tool("lsp_hover", { path: "out/f.ts", line: 1, character: 1 }), { success: false, output: "No hover info", error: "out/f.ts is not a readable file inside the workspace." });
    assert.deepEqual(s.rawLog(), [], "nothing was started"); // raw: there is no server
    assert.equal(s.mgr.serverStatus("out/f.ts")!.root, ".");
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------------------------------------------- the cap

const PACKAGES = Object.fromEntries(["a", "b", "c", "d"].flatMap((p) => [[`${p}/tsconfig.json`, "{}"], [`${p}/f.ts`, `${p}\n`]])) as Record<string, string>;

test(`the product keeps at most ${LSP_MAX_SERVERS} servers`, () => {
  assert.equal(LSP_MAX_SERVERS, 8);
  assert.equal(LSP_LIMITS.servers, LSP_MAX_SERVERS);
});

test("the cap on live servers (2 here): one more server first stops the least recently used one, and its process is gone before the new one answers", async () => {
  const s = open({ hover: "fromText" }, { "a.ts": "x\n", ...PACKAGES }, { spec: TS_RULE, limits: { servers: 2 } });
  const ask = (p: string) => s.tool("lsp_hover", { path: `${p}/f.ts`, line: 1, character: 1 });
  const pidOf = (root: string) => s.servers().find((x) => x.root === root)?.pid;
  try {
    await ask("a");
    await ask("b");
    const [a, b] = [pidOf("a")!, pidOf("b")!];
    assert.deepEqual(s.servers().map((x) => x.root), ["a", "b"]);

    assert.equal((await ask("c")).success, true);
    assert.equal(alive(a), false, "the least recently used server was stopped, and is gone when the query that displaced it returns");
    assert.equal(alive(b), true);
    assert.deepEqual(s.servers().map((x) => x.root), ["b", "c"]);
    const c = pidOf("c")!;
    assert.equal(s.mgr.serverStatus("a/f.ts")!.state, "not_started", "a stopped server is simply not running: its next query starts it again");

    // A query makes its server the most recently used: b is asked, so c is the one to go next.
    await ask("b");
    assert.deepEqual(s.servers().map((x) => x.root), ["c", "b"]);
    assert.equal((await ask("d")).success, true);
    assert.deepEqual([alive(b), alive(c)], [true, false]);
    assert.deepEqual(s.servers().map((x) => x.root), ["b", "d"]);

    // The evicted project is served again, by a new process, at the cost of the next least recently used.
    assert.deepEqual(held(await ask("a")), ["f.ts"]);
    assert.notEqual(pidOf("a"), a);
    assert.equal(alive(b), false);
    assert.equal(s.mgr.serverPids().length, 2);
    // Every process this test ever started, by pid: two are running, the rest are gone.
    const started = s.rawLog().filter((e) => e.event === "start").map((e) => e.pid!); // raw: stopped servers cannot answer the barrier
    assert.equal(started.length, 5);
    assert.equal(started.filter(alive).length, 2);
  } finally {
    await s.close();
  }
});

test("the cap never stops a server that is answering a query: with every server busy the new query is refused, and served once one is free", async () => {
  // a/f.ts is never answered, so its query stays in flight until it is cancelled.
  const s = open({ hover: { "f.ts": "never" } }, { "a.ts": "x\n", ...PACKAGES }, { spec: TS_RULE, limits: { servers: 1 }, timings: { coldStartMs: 0, queryMs: 30_000 } });
  try {
    const cancel = new AbortController();
    const waiting = s.mgr.hover("a/f.ts", 1, 1, cancel.signal);
    // raw, in a polling check: the barrier would need a server for the workspace root, and the cap is 1.
    assert.ok(await eventually(() => s.rawLog().some((e) => e.event === "recv" && e.method === "textDocument/hover")), "the query reached the server");
    const [{ pid }] = s.servers();

    assert.deepEqual(await s.mgr.hover("b/f.ts", 1, 1), { found: false, error: "The limit of 1 running language servers is reached and each is answering a query or starting; ask again when one has finished." });
    assert.equal(alive(pid), true, "the busy server was left alone");
    assert.deepEqual(s.servers().map((x) => x.root), ["a"]);

    cancel.abort();
    assert.match((await waiting).error ?? "", /cancelled/);
    // Free now: the next query for another root takes its place.
    assert.equal((await s.mgr.warmUp("b/f.ts"))!.root, "b");
    assert.equal(alive(pid), false);
    assert.deepEqual(s.servers().map((x) => x.root), ["b"]);
  } finally {
    await s.close();
  }
});
