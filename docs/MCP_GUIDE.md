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
nexus (engineering/b0) my-app ❯ /mcp
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

