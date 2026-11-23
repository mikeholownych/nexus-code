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

The current implementation was tested on PR #756 at `ee86b32d18b11ba8ed52b88be55966e21ece6e62`. The candidate includes the original MCP tool, the ACP extension, bounded worker shutdown on server signals, read-only resolution through flags/environment/config, and the ACP import-boundary allowlist update.

Local tests used fresh temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` directories. On Node `v24.11.1`, the focused MCP/ACP suite passed 69/69 before the later shutdown hardening; after that change, `mcp_verify.test.ts` passed 7/7 on Node 24. On Node `v22.23.5`, `mcp_verify.test.ts` passed 7/7, including caller cancellation and SIGTERM cleanup. The cancellation test also passed three additional targeted Node 22 repetitions. The ACP import-graph allowlist test passed on Node 22 and 24. TypeScript type-checking, schema generation check, and `git diff --check` passed.

The first hosted run on `f25030a3c0c0cc64e5abbefadad06c648a9b59c4` failed the ACP import-graph check because the new type-only import of `verify_contract` was missing from its allowlist. That omission was corrected. The same run had one Node 22 cancellation timeout; the focused Node 22 suite and three repeated cancellation cases passed locally, and that timeout did not recur in the following full CI run. Its cause was not established.

Hosted CI run [45265300422](https://github.com/mikeholownych/nexus-code/actions/runs/45265300422) completed successfully on `ee86b32d18b11ba8ed52b88be55966e21ece6e62`: both Node 22 and Node 24 test matrices, all eight test shards, Linux x86_64 packaging, TypeScript checks, and CodeQL passed. Diff coverage also passed. The separate `Entire Gates` check failed; it is not a required merge check under the repository's current instructions. The PR remains open and unmerged.

## Limits

- Receipts are held in memory and are lost when the server exits. MCP retains at most 32 receipts per process; ACP uses the same bounded service store.
- A client that can execute arbitrary commands as the server's operating-system user can change files, dependencies, Git settings or the Nexus installation outside this protocol. Use a separate operating-system account or CI when that actor is outside the trust boundary.
- A base commit made before the MCP server starts or before an ACP session starts is the baseline. Later commits are part of the change under verification.
- A verdict is the result of the configured verification procedure; it does not certify requirements correctness or prove that the verifier covers every relevant behavior.
