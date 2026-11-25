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

For ACP, start Nexus with the same operator options and the `acp` command. After `initialize` and `session/new`, call `_nexus/verify` with only `{ "sessionId": "<active-session-id>" }`. The client chooses the directory a session works in, so a verification covers that directory; the operator's verifier command and deliverable paths, fixed at start-up, are applied to it (a deliverable is a relative path, checked once at start-up against the directory Nexus was started for and then resolved inside the session's directory). The base is pinned per canonical directory by the first session on it, new or loaded, and reused by every later session on that directory for the life of the process; at most 16 directories are pinned, and one first used after that is refused verification. The result names the directory and the pin (`workspace`, `base_pinned_commit`, `base_pinned_at`); the receipt carries `workspace` and `base_pinned_at`. A verification receipt is read with `_nexus/receipt/get`, the session id it was issued to and its receipt id; it is visible only to that session, and a request without a receipt id returns turn receipts only. Verification is refused while an overlapping session is starting, prompting, or stopping, and a prompt is refused while a verification runs. `_meta` on the request is accepted and never read.

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

The service tests exercise caller-argument refusal, refusal when no operator verifier is approved, pinned-base behavior, cancellation, timeouts, worker cleanup, receipt integrity and eviction. The MCP tests exercise the actual stdio protocol. The ACP tests cover session-only arguments, pinned base, receipt binding, capability advertisement and cancellation. The review follow-ups are in `test/acp_verify_followups.test.ts` (the per-directory pin and its bound, turn receipts on a request without an id, the interlocks between a verification and a prompt, read-only refusal, a receipt read through a second active session) and in `test/acp_review_fixes.test.ts` (the signal deadline while a verification runs). Run the complete CI suite as the final check for the exact candidate.

## Execution evidence

The current implementation was tested on PR #756 at `ee86b32d18b11ba8ed52b88be55966e21ece6e62`. The candidate includes the original MCP tool, the ACP extension, bounded worker shutdown on server signals, read-only resolution through flags/environment/config, and the ACP import-boundary allowlist update.

Local tests for PR #756 used fresh temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` directories, on Node `v24.11.1` and Node `v22.23.5`; that record included the MCP caller-cancellation and SIGTERM-cleanup cases on both, three further Node 22 repetitions of the cancellation case, and the ACP import-graph allowlist test on both. The per-file counts of that run were not kept in a reproducible form and are not restated here.

The review follow-ups (per-directory base pin, `workspace` and pinned base in the result, turn receipts on a request without an id, interlock tests, signal deadline, `_meta`) were run on 2026-11-24 on the branch `v1/vr2-followups`, uncommitted, on Node `v24.11.1` only, each file by itself with a throwaway `HOME`: `acp_verify_followups` 8/8, `acp_review_fixes` 9/9, `acp_validate` 15/15, `acp_schema` 7/7, `acp_mapping` 22/22, `acp_client_conformance` 2/2 in that run (it drives real turns too: on the same host under heavier load it later passed 2/2 in six runs and 1/2 in two, and an independent reviewer saw 0/2 at this head and at the base alike; its wait for a turn was 10 s and is 45 s as of this change), `acp_jsonrpc` 11/11, `verify_service` 10/10, `mcp_verify` 7/7, `leak_guard` 6/6. `acp_stdio` has 9 tests: it passed 9/9 twice, and in every later run one or both of its two tests that drive a real sidecar turn (`ACP stdio completes a sidecar turn and exposes its receipt`, `read-only gate refusal stays final even if the client sends a forged allow reply`) timed out in their 10 s wait for the turn while the host was under load from other work; the second of them timed out in the same way 6 times out of 6 with the unmodified sources of `origin/release/v1.3.0` put back, so the timeouts are not attributed to this change, and their cause beyond host load was not established. The 7 tests of `acp_stdio` that do not run a real turn passed in every run. Removing the check that refuses `_nexus/verify` during a prompt fails `acp_verify_followups`; so do pinning per session, removing the pin bound and removing the prompt refusal during a verification, and restoring the old signal deadline fails `acp_review_fixes`. TypeScript type-checking, `gen_acp_schema.mjs --check` (schema v4), `check_invariants.mjs`, `check_doc_versions.mjs`, `check_critical_complexity.ts` and `git diff --check` passed. Node 22 and hosted CI have not run on these follow-ups.

The first hosted run on `f25030a3c0c0cc64e5abbefadad06c648a9b59c4` failed the ACP import-graph check because the new type-only import of `verify_contract` was missing from its allowlist. That omission was corrected. The same run had one Node 22 cancellation timeout; the focused Node 22 suite and three repeated cancellation cases passed locally, and that timeout did not recur in the following full CI run. Its cause was not established.

Hosted CI run [45265300422](https://github.com/mikeholownych/nexus-code/actions/runs/45265300422) completed successfully on `ee86b32d18b11ba8ed52b88be55966e21ece6e62`: both Node 22 and Node 24 test matrices, all eight test shards, Linux x86_64 packaging, TypeScript checks, and CodeQL passed. Diff coverage also passed. The separate `Entire Gates` check failed; it is not a required merge check under the repository's current instructions. The PR remains open and unmerged.

## Limits

- Receipts are held in memory and are lost when the server exits. MCP retains at most 32 receipts per process; ACP uses the same bounded service store.
- A client that can execute arbitrary commands as the server's operating-system user can change files, dependencies, Git settings or the Nexus installation outside this protocol. Use a separate operating-system account or CI when that actor is outside the trust boundary.
- A commit made before the MCP server starts, or before the first ACP session on a directory in a `nexus acp` process, is the baseline. Later commits are part of the change under verification. Restarting the server pins again, so the pin protects one run of the server, not a history of them.
- Over ACP the client chooses the directory. A verdict is about that directory, named in the result and the receipt, and about no other.
- Ending a verification that is cancelled, times out or is interrupted by a signal sweeps the verifier's process tree: every process below the worker is listed in one pass, stopped (`SIGSTOP`) and then signalled, and the listing repeats up to six times to catch processes forked while the sweep ran; a server that is exiting lists twice at most, so a hung `ps` cannot hold the exit. A tree is found whatever its depth. What is not guaranteed: a process that keeps forking in each of those passes, or forks between the last listing and its own stop, can start a child that outlives the sweep (the pass limit is a bound, not a proof that nothing is left). Under `--sandbox bwrap` the verifier also runs in its own PID namespace, which ends with the sandbox, so the residual applies to the host verifier path and to Docker. `test/verify_service_tree.test.ts` covers a 14-generation chain that ignores SIGTERM; no test exercises the exhaustion of the pass limit.
- A verdict is the result of the configured verification procedure; it does not certify requirements correctness or prove that the verifier covers every relevant behavior.
