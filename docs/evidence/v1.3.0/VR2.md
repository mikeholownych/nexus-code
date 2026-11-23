# VR-2: verification for external harnesses

This record describes how to reproduce the verification boundary exposed by `serve-mcp` and the ACP stdio adapter. The boundary reuses the existing `nexus verify` implementation. It does not establish that an arbitrary verifier is correct; it records what Nexus ran and which verdict it returned.

## Operator configuration

The server operator supplies the verifier and product deliverables at process start. For example:

```sh
nexus --authoritative-verifier "npm test" \
  --deliverable-file src/parser.ts \
  serve-mcp --workspace /path/to/project
```

The MCP tool `nexus_verify` takes no arguments. A caller cannot choose the command, base commit, deliverables, verdict, or sandbox. Read-only mode and managed policy requirements for human approval refuse the request before verification runs. Verification defaults to the existing confined, network-disabled behavior; if no usable sandbox is available, the result is not promoted to a successful verdict.

For ACP, start Nexus with the same operator options and the `acp` command. After `initialize` and `session/new`, call `_nexus/verify` with only `{ "sessionId": "<active-session-id>" }`. The base is pinned when the session starts or loads. `_nexus/receipt/get` accepts that session id and, optionally, the receipt id returned by verification. A receipt is visible only to the session that produced it. Verification is refused while an overlapping session is starting, prompting, or stopping.

## Automated reproduction

From `cli/`, use a throwaway home for each test invocation:

```sh
(
  isolated_home="$(mktemp -d)"
  trap 'rm -rf -- "$isolated_home"' EXIT
  HOME="$isolated_home" node --import tsx --test test/verify_service.test.ts
)

(
  isolated_home="$(mktemp -d)"
  trap 'rm -rf -- "$isolated_home"' EXIT
  HOME="$isolated_home" node --import tsx --test test/mcp_verify.test.ts
)

(
  isolated_home="$(mktemp -d)"
  trap 'rm -rf -- "$isolated_home"' EXIT
  HOME="$isolated_home" node --import tsx --test test/acp_stdio.test.ts test/acp_validate.test.ts test/acp_mapping.test.ts test/acp_schema.test.ts
)
```

The service tests exercise caller-argument refusal, refusal when no operator verifier is approved, pinned-base behavior, cancellation, timeouts, worker cleanup, receipt integrity and eviction. The MCP tests exercise the actual stdio protocol. The ACP tests cover session-only arguments, pinned base, receipt binding, capability advertisement and cancellation. Run the complete CI suite as the final check for the exact candidate.

## Execution evidence

The tested tree was the open PR #756 head (`4196a306c97152ff735498d7c6bdb5a0bcdd0c75`) plus the ACP implementation and schema-test correction. The binary Git diff from that head was SHA-256 `0985ec6f4b9d449d0981f1758f722000fe0a24c00ec3f7222a8235165d36c5e3`; the same patch is applied in the isolated branch `v1/vr2-acp-update`. No hosted CI has run on these additional changes yet.

On Node `v24.11.1`, from `cli/`, with fresh temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` directories:

```sh
node --import tsx --test test/acp_stdio.test.ts test/acp_validate.test.ts test/acp_mapping.test.ts test/acp_schema.test.ts test/mcp_verify.test.ts test/verify_service.test.ts
```

Result: exit 0; 69 tests passed, 0 failed, 0 skipped. The suite covers the MCP verifier, worker cancellation and timeout, ACP session-bound verification and cancellation, validation, mapping, and generated schema. The first run exposed one stale test expectation for the schema filename after the adapter moved to schema v2; the expectation now follows the current schema version, and the complete focused run passed afterward.

Also passed on Node `v24.11.1`: `node --import tsx --test test/acp_schema.test.ts` (7/7), `npm run typecheck`, `node cli/scripts/gen_acp_schema.mjs --check`, and `git diff --check`. Node 22 was not available in this environment. The full repository suite has not been run on this candidate. Hosted CI remains outstanding.

## Limits

- Receipts are held in memory and are lost when the server exits. MCP retains at most 32 receipts per process; ACP uses the same bounded service store.
- A client that can execute arbitrary commands as the server's operating-system user can change files, dependencies, Git settings or the Nexus installation outside this protocol. Use a separate operating-system account or CI when that actor is outside the trust boundary.
- A base commit made before the MCP server starts or before an ACP session starts is the baseline. Later commits are part of the change under verification.
- A verdict is the result of the configured verification procedure; it does not certify requirements correctness or prove that the verifier covers every relevant behavior.
