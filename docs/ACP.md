# Agent Client Protocol

`nexus acp` serves the supported subset of ACP v1 over newline-delimited JSON-RPC on standard input and output. Standard
output is reserved for protocol messages. Diagnostics and model activity do not become JSON-RPC success responses.

The adapter runs each session through Nexus's existing `ApplicationCore` and `SidecarServer`, preserving workspace
policy, read-only restrictions, tool authorization, verification, and receipt generation. ACP clients cannot change the
operator's execution mode or policy. A permission response can approve one pending action only; rejecting, cancelling,
an unknown option, or a malformed response denies that action. A client cannot turn a policy refusal into an approval.

The adapter supports `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, protocol request
cancellation, streamed messages and tool updates, client-bound permission requests, and `_nexus/receipt/get`. The
connection accepts at most four sessions, 32 in-flight requests, one pending permission per session, and a bounded
JSON-RPC line. Three overlong lines close the connection. A permission request that receives no answer is denied after
ten minutes.

## Declared limitations

- Client-supplied MCP servers are ignored and reported in session metadata. Configured operator and project integrations
  remain governed by Nexus's existing policy.
- `session/load` replays the complete retained transcript in bounded pages. Loads fail closed if committed compaction
  history is missing, unreadable, corrupt, or exceeds 32 MiB, 1,024 pages, or 64 KiB per page; no partial replay is returned.
- The receipt extension returns receipts retained by the current ACP connection. It is not a durable cross-connection
  receipt lookup API.
- ACP conformance against external clients is tracked separately in v1.3 plan unit AC-2.

Use a normal Nexus configuration and start the adapter with `nexus acp`. The client supplies the canonical project
directory in `session/new` or `session/load`; all tool access stays subject to Nexus's configured approval and verification
controls.
