# Model Context Protocol (MCP) Guide

Nexus Code features full client support for Anthropic's **Model Context Protocol (MCP)** using the JSON-RPC 2.0 stdio transport. This allows the autonomous agent to interact with external databases, APIs, git servers, and system utilities.

---

## 1. MCP Configuration

MCP servers are configured via JSON files located at:
1. Workspace root: `.mcp.json`
2. Global configuration: `~/.config/nexus/mcp.json`

### Configuration Schema

```json
{
  "mcpServers": {
    "sysinfo": {
      "command": "node",
      "args": ["/home/mike/.config/nexus/servers/sample_mcp.js"],
      "env": {
        "DEBUG": "1"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost:5432/mydb"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/mike/shared"]
    }
  }
}
```

---

## 2. Tool Mapping & Execution

When Nexus Code initializes, it launches each configured MCP server process over standard input/output (`stdio`), conducts the JSON-RPC initialization handshake, and queries available tools via `tools/list`.

- **Namespace Isolation**: MCP tools are automatically namespaced as:
  ```text
  mcp__<server_name>__<tool_name>
  ```
  *Example:* `mcp__sysinfo__get_system_specs` or `mcp__postgres__query`.
- **Dynamic Tool Dispatch**: When the model invokes an MCP tool, Nexus Code serializes arguments, executes `tools/call` over JSON-RPC, and returns the response directly into context.
- **Graceful Teardown**: Background MCP processes receive `SIGTERM` and close stdio when Nexus Code shuts down, preventing dangling zombie processes.

---

## 3. Managing MCP in Nexus Code

### Checking Server Status via CLI
```bash
nexus mcp
```
Output:
```text
=== Configured MCP Servers ===

• sysinfo [CONNECTED]
  Command: node /home/mike/.config/nexus/servers/sample_mcp.js
  Tools: 1

=== Discovered MCP Tools ===

⚡ mcp__sysinfo__get_system_specs: Returns hardware CPU core counts, platform info, and free RAM
```

### Checking Server Status in Interactive REPL
Type `/mcp` at the REPL prompt:
```text
nexus (qwen2.5-coder) my-app ❯ /mcp
```
All discovered tools are immediately accessible to both the user and the autonomous model.

---

## 4. Serving Nexus Code as an MCP Server (`serve-mcp`)

Nexus Code can also operate as a high-performance **MCP Server**, exposing its Rust-accelerated software engineering tools to external AI environments such as Claude Desktop, Cursor, Zed, or Antigravity:

```bash
harness serve-mcp --workspace /path/to/project
```

### Client Configuration (Claude Desktop, Cursor, Zed)

Add Nexus Code to your external assistant's MCP configuration file:

```json
{
  "mcpServers": {
    "nexus-code": {
      "command": "harness",
      "args": ["serve-mcp", "--workspace", "/path/to/project"]
    }
  }
}
```

External clients immediately gain access to Nexus Code's complete native tool suite (`file_tree`, `batch_read`, `file_info`, `search_code`, `patch_file`, `edit_file`, `run_command`) with workspace jail security and sub-millisecond Rust acceleration.

### Verification for the client: `nexus_verify`

`serve-mcp` also lists `nexus_verify`. It runs the same check as `nexus verify` (no model) on the workspace's working tree and returns a verdict and a receipt id. The client is treated as untrusted, so the tool takes **no arguments**: a call with any argument, or any member beside `name`, `arguments` and `_meta`, is refused with JSON-RPC error `-32602` and nothing runs.

Everything that can raise a verdict is fixed by the operator who starts the server:

```bash
nexus --authoritative-verifier "npm test" --deliverable-file src/parser.ts serve-mcp --workspace /path/to/project
```

| Input | Where it comes from |
|---|---|
| Verifier | `--authoritative-verifier` only. A verifier discovered in the repository is never approved here: the result is `BLOCKED` / `VERIFIER_NOT_APPROVED`, nothing is executed, and the client is not asked. |
| Deliverables | `--deliverable-file` (repeatable). Without one the best verdict is `REGRESSION_FREE`. |
| Base | The commit `HEAD` named when the server started. A commit made later is part of the change. |
| Change | The working tree on disk in the served workspace. |
| Sandbox | The default of `nexus verify`: confined, network off. There is no opt-out; without a usable engine the result is `BLOCKED` / `SANDBOX_UNAVAILABLE`. |
| Deadline | `NEXUS_VERIFIER_TIMEOUT_SECS` (default 300 s) per verifier run, read when the server starts. A whole verification is stopped after six such runs plus five minutes. |

The result text is one JSON object: `service_version`, `receipt_id` (`vr-` and 32 hex digits), `receipt_uri`, `receipt_sha256`, `verify_schema_version`, `verdict`, `outcome`, `reason`, `detail`, `base`, `head`, `verifier`, `operator_hint` and `issued_at`. Every verdict, `BLOCKED` and `UNVERIFIED` included, is a normal result (`isError: false`) with a receipt. `isError: true` means no verdict was reached and no receipt exists; the text is then `{ "schema_version", "error", "exitCode" }`. That happens when:

- a verification is already running (one at a time per server; the second call is refused, not queued);
- the server runs in read-only mode (`--read-only`, `--mode read-only` or `NEXUS_APPROVAL_MODE=read-only`), or the managed policy requires a person for command execution (`approval.require_human` with `exec`);
- the workspace had no commit when the server started;
- the verification was stopped by its deadline, or the result document was larger than 4 MiB.

`notifications/cancelled` with the request's id stops the verification (the worker process and the verifier it runs); as MCP specifies, no response follows. Closing the server's stdin stops it as well.

Read a receipt with `resources/read` on `nexus://verify-receipt/<receipt_id>`. It holds the full `nexus verify` result document (`result`, schema v3), the workspace, when the base was pinned, and `receipt_sha256`, the SHA-256 of `JSON.stringify(result)`. `resources/list` shows the retained receipts. Receipts are kept in the server's memory only: the last 32, gone when the server exits. No request can create or change one.

**What this does not protect against.** The guarantee is about the request. `serve-mcp` gives the same client `run_command`, and a client that can run commands as the server's user can act outside the protocol. No check inside the server stops any of the following:

- It can change what verification links in from the workspace: installed dependencies (`node_modules`, `.venv`), which Git ignores.
- It can edit the server user's home: `~/.config/nexus/config.env` (operator settings such as `NEXUS_VERIFIER_ENV_PASSTHROUGH`), a user-tier managed policy, and the user's Git configuration.
- It can replace the operator's verifier script, or a binary the verifier finds on `PATH`, when these live outside the workspace: they are as writable by that user as anything else. The Nexus installation itself is too.
- A receipt is not secret from the client. It carries the workspace path, changed file names and the end of the output of a verifier run that did not pass, as the `nexus verify` result document does.
- If the server is killed with SIGKILL, the running verifier goes on until its own deadline and the scratch directories of that verification stay in the temp directory. SIGTERM and SIGINT stop the verification and remove them before the server exits.

Where the client is not trusted to that degree, run the server as a separate user or in CI.

