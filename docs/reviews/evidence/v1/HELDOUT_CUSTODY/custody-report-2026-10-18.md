# Held-out T2 corpus (heldout-v2): custody and seal record

| | |
|---|---|
| Date sealed | 2026-10-18T03:05:52Z |
| Custodian | `opencode` primary session (custodian/integrator role; never authored a task) |
| Sealed manifest | `eval/heldout-manifest.json` — sha256 `50895b84a604fbfd45ed82e29cbef4ba795d7fffbe6611af23bfbc9851f3e89b` |
| Store (private; not in the repository) | `/home/mike/nexus-heldout-v2` — `tasks/<id>/task.json`, `tasks/<id>/hidden/**`, `reference/<id>.patch`, `reference/<id>.validation.log`, `MANIFEST-batch1..9.json` |
| Requirement | REQ-QUAL-101 (DEC-05): 40 T2 tasks, ≥ 20 external pinned, ≥ 6 per class, four languages; manifest committed before RC freeze (CONCURRENCY §8, PLAN-10 task 8) |

This record contains approved metadata only. It does not contain objectives, hidden tests, reference patches, or anything that would let a reader reconstruct a task. Repository URLs and pinned baseline commits are in the manifest by contract (hash scheme C2).

## 1. Corpus identity

| Property | Value |
|---|---|
| Tasks | 40, ids `ho2-<lang>-<class>-<nn>` |
| By class | bugfix 10, debug 10, feature 10, refactor 10 |
| By language | go 10, javascript 10, python 10, rust 10 |
| External repositories, pinned 40-hex commit | 40 / 40 (baseline = parent of the upstream fix or feature; `setup` stages a committed, reflog-pruned baseline) |
| Hash scheme | `task_sha256` = sha256 of raw `task.json` bytes; `hidden_sha256` = sha256 over sorted `"<path>  <sha256(file)>\n"` lines of `tasks/<id>/<hidden.dir>` (`bin/hidden_digest.mjs`). Re-derivable by anyone holding the store. |
| Seal tool | `bin/seal.mjs` (sha256 `c7fedb77420839b4796e03b05bf552034d6938411073ab2bf17567ac7dd19d0c`): merges batch manifests, re-derives every hash, refuses any task not custodian-validated, enforces composition. Output above. |
| Validator | `bin/validate.py` (sha256 `62133a649b5a6715dd212840a1ff16497aa2231b92a9eb8657fc8d821ca5c2cb`): fresh clone → checkout → setup → regression (pass) → hidden (fail) → reference patch (apply) → hidden (pass) → regression (pass). Go via `/usr/local/go/bin`, `GOFLAGS=-mod=mod`, GOPATH/GOCACHE/GOMODCACHE under the store; cargo home under the store; offline after clone. |
| Contract | `CONTRACT.md` sha256 `99ecef6656825cf325f33e79e382c700dc8e400e8bf02e96691741572262a057`; store `AGENTS.md` (isolation rules) sha256 `319e6eeba78871ee4c91a33e0d8db25d59c191264cc4fd74a7a2bf363c0eca12` |

Post-seal rule (CONTRACT, CONCURRENCY §8): no case swaps, no threshold changes, no edits to `eval/heldout-manifest.json` by any implementing agent. Any change to the store invalidates the seal and requires re-sealing with a new manifest hash.

## 2. Authorship and independence (actual role, context, access)

| Batches | Author | Session / provider | Context and access | Outcome |
|---|---|---|---|---|
| 1–7 (31 tasks) + the `ho2-go-debug-02` repair | `author-v2` | isolated subagent spawned by the custodian's opencode session, 2026-10-17 18:0xZ – 2026-10-18 01:1xZ | inputs: `CONTRACT.md`, `bin/`, public upstream repositories; no Nexus checkout, no dev/pilot store | 31 accepted; provider usage-limited ~01:1xZ (reset 11:43Z); claim `HELDOUT_AUTHORING` left in place and **not impersonated**; transfer notice written to the store (`AUTHOR-TRANSFER-2026-10-18.md`) |
| 8 (5 tasks) | `author-b8c` | OpenAI Codex `exec` 0.163 (`gpt-6-luna`), fresh non-interactive session `01a14ce0-3339-7733-8afe-d5036bac31d6`, launched with `--disable memories --disable hooks --disable skill_search -c mcp_servers={}`, cwd confined to the store; resumed twice (to finish the batch; to apply the custodian soundness repair) | inputs recorded in `MANIFEST-batch8.json#provenance`; custodian audited every exec line of the session log: no read outside the store except its own claim dir and one claim-log line; no other task's hidden/reference files | 5 accepted (3 inherited author-v2 drafts verified and re-worded; 2 new) |
| 9 (4 tasks) | `author-b9c` | same launch form, fresh session `01a14ce0-fc89-7650-87b6-d39d7ec9140a`, resumed twice (selection guidance; soundness repair) | same audit, clean; `MANIFEST-batch9.json#provenance` | 4 accepted |
| Rejected: batch 9 first attempt | `author-b9` | Codex `exec` launched 02:25Z **without** `--disable memories` | session read `~/.codex/memories/MEMORY.md` (contains Nexus implementation and tuning notes) and the author self-disclosed a memory-registry search plus globbing other tasks' validation logs | **Rejected for provenance** 02:37Z; all writes quarantined outside the store (`/home/mike/nexus-heldout-v2-quarantine/b9-contaminated-2026-10-18T0235Z/`, never an input to any later author). Its slots were re-authored by `author-b9c`, who could not read the quarantine (audited). One slot independently reused the same upstream repository at a different commit and scenario. |
| Aborted: `author-b8` (opencode subagent, died with its spawning session, no output) and `author-b8r` (Codex, aborted ~60 s after launch for the same memory exposure, no output) | — | — | recorded as broken/aborted claims in the claim log | nothing accepted |

Separation: the implementation agents (codex app-server sessions and `kiro-cli` on the Nexus repository) authored nothing. The custodian authored nothing and edited task files never; it edited store bookkeeping (`ASSIGNMENT-*.md`, `AUTHOR-TRANSFER-2026-10-18.md`, `AGENTS.md`) and ran the validator. Authors never ran `bin/validate.py` and never held the `SUITE` claim.

## 3. Custodian validation

Every task was validated by the custodian in a bounded, atomically claimed `SUITE` window (claim log lines `CLAIM SUITE opencode v7/v8/v9/v10/v11`, each released with `RELEASE SUITE`). Rounds: batches 1–7 one round each (windows v7, v8); batches 8–9 and the repaired task two rounds each (v9–v11). Per-task logs: `reference/<id>.validation.log` in the store. Claim-log evidence: one `VALIDATED <id> rounds=N (<window>)` line per task; latest line governs.

Pre-seal integrity check (custodian script, 03:05Z): for all 40 tasks, `task_sha256` and `hidden_sha256` equal the batch manifest entries, and no `task.json`, hidden file, or reference patch has a modification time later than the task's latest validation. The three batch-8 tasks whose objectives were repaired were revalidated afterwards (hidden tests and patches unchanged).

Composition and schema: `bin/check_schema.mjs` OK for all 40 (authors' manifests; re-checked by `seal.mjs` through hash re-derivation); composition enforced by `seal.mjs` (≥ 40, ≥ 6 per class, ≥ 20 external) and exceeded (10/10/10/10, 40 external).

## 4. Defects found and dispositions

| Task | Finding | Disposition |
|---|---|---|
| `ho2-go-debug-02` (batch 4) | custodian v7 run failed: repository's own suite failed at the pinned commit on this host (Go 1.26 `go vet` rejects a pre-existing `%q` printf verb in the repo's `range_test.go`), so neither baseline nor reference could pass | author-v2 repaired it 01:11Z (before its limit) by adding a deterministic `setup` step that stages a vet-compatible verb change in that existing test file; hidden test and regression command unchanged; validated v9 (2 rounds). Restricted failure evidence given to the assigned author was limited to this task's exit codes. |
| `ho2-go-refactor-03`, `ho2-rs-refactor-03` (batch 8), `ho2-rs-feature-03` (batch 9) | validated, but hidden tests bound to new API names/signatures that the objective never stated (unsolvable from the task text) | custodian hold 02:54Z / 03:03Z; authors rewrote the objectives to state the required interface (no hidden-test loosening); `ho2-rs-feature-03`'s first rewrite quoted the hidden test's exact example values and was revised to different examples; all revalidated |
| `ho2-go-feature-03` | objective hinted API names only via a grep | signatures made explicit; revalidated |
| `ho2-py-refactor-03` | regression command deselects one test (`tests/test_arguments.py::test_bytes_args`) | verified on the pristine baseline: fails with a pytest-9 `DontReadFromInput.encoding` setter `AttributeError`, unrelated to the task; recorded, accepted |
| `ho2-js-debug-03` | `setup` commits a one-line `is-buffer` shim (`Buffer.isBuffer`) because the pinned baseline's dependency is unavailable offline; regression runs the repo's full `test/test.js` with mocha globals stubbed | shim is semantically equivalent for Node Buffers; full suite exercised; recorded, accepted |
| Batches 1–7 | heuristic re-check (new symbols introduced by the reference patch, referenced by hidden tests, absent from the objective) | none flagged; no revalidation needed |

No task was selected, dropped, or adjusted based on any qualification outcome. No validator was loosened. Pilot/development material (`/home/mike/nexus-heldout/`) was never an input and is not part of this corpus.

## 5. Open items that gate *use* of this corpus (updated 2026-10-18T12:10Z)

1. **Harness history leak — CLOSED (`96aeef2`, PR #18; canary `6a334fa`, PR #26).** `eval/workspace.mjs` stages external-repo tasks via `git init` + ancestor-only fetch (`--no-tags`, `--no-write-fetch-head`), with no `--shared`, alternates, remotes, tags, or post-baseline commits.
2. **Kernel resource contract — SOURCE-IMPLEMENTED (`91406bd`, PR #19; dedicated-tmpfs preflight `6a334fa`, PR #26).** Host provisioning (`eval/host/provision.sh`, PR #31) and custodian reference calibration / resource-profile freeze remain required before running T2/T3/T4 qualification.
3. **Evaluator hidden-test execution boundary (distinct from corpus custody; qualification blocker until independently accepted).** All 40 T2 tasks in `heldout-v2` are pinned external repositories across Go, Rust, Python, and JavaScript that use `hidden: { dir, into, command }` and `regression: { command }`. Corpus custody acceptance below covers the sealed store identity (`50895b84…`), author isolation, reference validation, and the `root:root` `0700`/`0500` store DAC boundary; it does **not** constitute evaluator execution-boundary acceptance. If post-agent hidden tests run in the same process/mount namespace as candidate-controlled code with readable hidden test files, hidden-validator confidentiality and zero-test/early-exit resistance remain open qualification blockers until the evaluator boundary is remediated and independently accepted.
4. Peer calibration, Node runtime parity and the frozen run record (ACCEPTANCE §6.1) are unchanged by this seal.

## 7. Store access control and root-owned DAC boundary (updated 2026-10-18T10:38Z / 12:10Z)

After initial tightening to `0700` `mike:mike` (03:15Z), the coordinator noted at 10:36Z that implementation agent shells also run as uid `mike` (`1000`). At 10:38Z the custodian transferred ownership of the sealed T2 store, the T2 quarantine, and the sealed T3 store to `root:root` with mode `0700` on store roots and `0500` read-only on `tasks/` and `reference/`:

```
drwxr-xr-x 755 root:root /
drwxr-xr-x 755 root:root /home
drwxr-x--- 750 mike:mike /home/mike
drwx------ 700 root:root /home/mike/nexus-heldout-v2
dr-x------ 500 root:root /home/mike/nexus-heldout-v2/tasks
dr-x------ 500 root:root /home/mike/nexus-heldout-v2/reference
drwx------ 700 root:root /home/mike/nexus-heldout-v2-quarantine
drwx------ 700 root:root /home/mike/nexus-heldout-t3
dr-x------ 500 root:root /home/mike/nexus-heldout-t3/tasks
dr-x------ 500 root:root /home/mike/nexus-heldout-t3/reference
```

Verified as uid `mike` (`1000`): `ls /home/mike/nexus-heldout-v2` and `ls /home/mike/nexus-heldout-t3` fail with `Permission denied` (`getfacl` is not yet installed on the host, so independent ACL enumeration remains pending host provisioning). Verified inside `agentSandboxArgv` (`eval/isolate.mjs`): `/home/mike/nexus-heldout-v2`, `/home/mike/nexus-heldout-v2/tasks`, `/home/mike/nexus-heldout-v2/reference`, and `/home/mike/nexus-heldout-v2-quarantine` all return `ENOENT` (`--tmpfs /home` hides `/home/mike` contents). Re-derived all 40 `task_sha256` and `hidden_sha256` digests against `eval/heldout-manifest.json`: 40/40 match (`50895b84a604fbfd45ed82e29cbef4ba795d7fffbe6611af23bfbc9851f3e89b`). **Custodian disposition: SEALED-MANIFEST CORPUS CUSTODY ACCEPTED (evaluator execution-boundary acceptance tracked separately in §5.3).**

## 6. Claim-log pointers

`$(git rev-parse --git-common-dir)/nexus-claims.log`, 2026-10-18: `TRANSFER HELDOUT authorship` 02:25:21Z; `BROKEN CLAIM HELDOUT_AUTHORING_B8` 02:33:14Z; `ABORT … author-b8r` 02:35Z; `REJECT HELDOUT batch 9` 02:37Z; `CLAIM/RELEASE SUITE opencode v9` 02:4xZ–02:54:09Z, `v10` 02:5xZ–03:01:22Z, `v11` 03:0xZ–03:05Z; `CUSTODY NOTE v9`, `CUSTODY HOLD` 02:54:09Z; `VALIDATED` lines per task; `BOUNDARY REQUEST (QUALIFICATION BLOCKER)` 03:05:08Z.
