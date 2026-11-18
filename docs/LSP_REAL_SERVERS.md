# Real language servers (CS-6)

`cli/src/lsp.ts` (the `lsp_diagnostics`, `lsp_hover` and `lsp_definition` tools) is tested in the ordinary suite only against `cli/test/fixtures/fake_lsp_server.mjs`. `cli/test/lsp_real_servers.test.ts` runs the product's own `LspBridgeManager` against the real servers on a tiny fixture project written to a temporary directory. The `lsp-real-servers` workflow runs it weekly (Monday 04:17 UTC) and on demand. It is not a required check.

Per server the test asserts three things: a file with one deliberate error yields `status: "ok"` with an error diagnostic whose message names it; a clean file yields `status: "ok"` with an empty list (a published report, which is not `unavailable`); and a manager whose server cannot start yields `unavailable`.

| Server | Command the product starts | Fixture error | Needed to run |
|---|---|---|---|
| typescript | `typescript-language-server --stdio` | `const n: number = "..."` under `strict` | `typescript`, `typescript-language-server` |
| python | `pyright-langserver --stdio` | `x: int = "..."` | `pyright` |
| rust | `rust-analyzer` | `let x: i32 = "..."` in a Cargo project | `rust-analyzer` |
| go | `gopls` | `var x int = "..."` in a module | `gopls` |

## Skip versus fail

The server is looked up on the PATH the product gives a language server (`buildLspEnvironment`: absolute entries only, none inside the workspace), and where the server has a `--version` mode it is run under that same environment. A server that is absent, or present but not runnable there, SKIPS with the reason. `NEXUS_LSP_REQUIRE` turns that into a failure: `1` (or `all`) requires every server, a comma list (`typescript,python`) requires those. Ids: `typescript`, `python`, `rust`, `go`. The workflow sets `typescript,python`; rust-analyzer and gopls are best-effort installs there, so their cases run when the install worked and skip otherwise.

```sh
npm i -g typescript typescript-language-server pyright   # or put their bin directory on PATH
cd cli && node scripts/run_tests.mjs test/lsp_real_servers.test.ts
NEXUS_LSP_REQUIRE=1 node scripts/run_tests.mjs test/lsp_real_servers.test.ts   # missing server = failure
```

The suite runs under a throwaway HOME, so a tool installed only for the current user (`pip install --user`, `~/.cargo/bin` reached through the real HOME) is invisible. The workflow installs with `npm -g`, and sets `RUSTUP_HOME` and `CARGO_HOME` for the rustup proxy.

## What it found

The first real run showed the default launch commands for TypeScript, JavaScript and Python were missing `--stdio`; both servers print a usage error and exit without it, so `lsp_diagnostics` for those files was always `unavailable` in practice. Fixed in `getServerForFile`; a test that needs no server pins the arguments.

## What it does not cover

- `lsp_hover` and `lsp_definition` against real servers (diagnostics only).
- The trust and sandbox gates with a real server (they are tested with the fake server; a gated manager never starts one).
- A real project: the fixtures are one or two files. No incremental edits, no multi-file or workspace-wide diagnostics, no server crash or restart.
- Server versions other than the pinned ones (typescript 5.6.3, typescript-language-server 4.3.4, pyright 1.1.390; gopls v0.16.2 and the runner's rust-analyzer are unpinned by the toolchain).
- Hosted-runner result (manual run 44323291710 on `3732d911`, 2026-11-18): **typescript-language-server, pyright and gopls passed** (a deliberate error reported, a clean file a real empty report, a broken server `unavailable`), which also confirms on real servers that the default launch needs `--stdio`. **rust-analyzer failed**: the product reported "not installed or failed to start" although the rustup proxy answered `--version` in the test's probe. The cause is not diagnosed (it needs a host with the rust-analyzer component to reproduce); the Rust case therefore runs as a `todo` (reported, not failing the job) unless `NEXUS_LSP_REQUIRE` names it, and the workflow requires `typescript,python,go`.
