# Agent Client Protocol

`nexus acp` serves the supported subset of ACP v1 over newline-delimited JSON-RPC on standard input and output. Standard
output is reserved for protocol messages. Diagnostics and model activity do not become JSON-RPC success responses.

The adapter runs each session through Nexus's existing `ApplicationCore` and `SidecarServer`, preserving workspace
policy, read-only restrictions, tool authorization, verification, and receipt generation. ACP clients cannot change the
operator's execution mode or policy. A permission response can approve one pending action only; rejecting, cancelling,
an unknown option, or a malformed response denies that action. A client cannot turn a policy refusal into an approval.

The adapter supports `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, protocol request
cancellation, streamed messages and tool updates, client-bound permission requests, `_nexus/receipt/get`, and
`_nexus/verify`. The
connection accepts at most four sessions, 32 in-flight requests, one pending permission per session, and a bounded
JSON-RPC line. Three overlong lines close the connection. A permission request that receives no answer is denied after
ten minutes.

## `_nexus/verify`

`_nexus/verify` runs the check of `nexus verify` (no model) on the working tree of a session's directory and returns a
verdict and a receipt id. Its params are `{ "sessionId": "<active session>" }`. Any other member is refused with
`-32602` and nothing runs. `_meta` is the exception, treated as on every other method of the adapter: it is accepted,
never read and never validated, so nothing placed in it changes a verification.

What a verification covers:

- **The directory is the client's choice.** The client names a session's directory in `session/new` or `session/load`,
  and a verification covers that directory (its canonical path, which must be the top of a Git working tree). A verdict
  says nothing about any other directory. The result (`workspace`) and the receipt (`workspace`) name it.
- **The verifier and the deliverables are the operator's.** They are fixed when `nexus acp` starts
  (`--authoritative-verifier`, `--deliverable-file`) and no request changes them. Each `--deliverable-file` is checked
  once at start-up against the directory Nexus was started for (`--workspace`, else its working directory): a literal
  relative path that stays inside it, is not a test file and is not reached through a symlink. What is kept is the
  relative path. Every verification applies the same verifier command and the same relative paths to the session's
  directory, so `src/parser.ts` means `<session directory>/src/parser.ts`; the start-up check is not repeated there.
  Without `--authoritative-verifier` no verifier runs and the verdict is `BLOCKED` or `UNVERIFIED`.
- **The base is pinned per directory, for the life of the process.** The first session on a directory, new or loaded,
  pins the commit `HEAD` names then. Every later session on that directory uses the same pin, so a commit made after
  it is part of the change under verification, whichever session asks. Commits made before the first session on that
  directory are the baseline, and restarting `nexus acp` pins again. A directory with no commit at its first session
  cannot be verified until a restart. The result carries `base_pinned_commit` and `base_pinned_at`; the receipt
  carries `base_pinned_at`, and the base commit in `result.base` when the verification got as far as resolving it.
- At most 16 directories are pinned per process. A directory first used after that is refused verification with an
  error that says so; no pin is replaced.

A verification is refused, and nothing runs, in read-only mode, when managed policy requires a person to approve
command execution, while any session is starting or loading, while a session on an overlapping directory has a prompt
running or is still stopping one, and while another verification runs. While a verification runs, `session/new`, `session/load` and
`session/prompt` on an overlapping directory are refused. `$/cancel_request` with the request's id stops it; `session/cancel`
does not. Every verdict, `BLOCKED` and `UNVERIFIED` included, is a result with a receipt; an error means no verdict
was reached and no receipt exists. A verification sends no `session/update`.

Read a verification receipt with `_nexus/receipt/get` and both the `sessionId` it was issued to and its `receiptId`;
any other session gets "not available". Without `receiptId` the method returns the session's last turn receipt, as it
did before `_nexus/verify` existed, and never a verification receipt.

On SIGTERM or SIGINT a running verification is stopped and the process waits for it, for up to the verifier's kill
grace plus five seconds (15 s), before it exits.

The limits described for `nexus_verify` in [MCP_GUIDE.md](MCP_GUIDE.md) apply here too: a client that can run commands
as the server's user can change what a verification links in, the operator's settings, the verifier itself or the Nexus
installation, outside this protocol. Where the client is not trusted to that degree, run `nexus acp` as a separate user
or verify in CI.

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
