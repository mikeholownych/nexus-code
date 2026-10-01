# PERS-002 Durable Persistence Protection Evidence

## Requirement and acceptance criterion

The authoritative Phase 2 requirement is:

> Nexus MUST NOT create uncontrolled, unredacted durable copies of credentials or classified sensitive data through session transcripts (`~/.nexus/sessions/`), flight logs (`.nexus/flights/`), audit logs, checkpoints, caches, or crash artifacts.

Its acceptance criterion is:

> Serialization owners (`SessionManager`, `FlightRecorder`) MUST apply sensitive-data protection policies prior to writing records to disk.

The Phase 3 architecture maps durable state to `DurableStateManager` and `SessionManager`; Phase 4 maps PERS-002 to WP-07 / INC-08. The accepted WP-07 qualification tested interrupted-operation cleanup and state recovery, but its PERS-002 interpretation did not exercise arbitrary session message content through `SessionManager.saveSession()`. The final Issue #12 reconciliation identified that uncovered path.

## Original defect reproduction

Before the correction, an isolated temporary `SessionManager` was given representative session state containing a synthetic GitHub-style credential in nested messages. The real `saveSession()` path serialized through `DurableStateManager` into the session JSON file. Reading that file from disk confirmed that the exact synthetic plaintext remained present. Similar isolated reproductions found plaintext in a `KnowledgeGraph` value and in both Git and non-Git checkpoint content. No real credentials were used.

The focused regression `session persistence scrubs nested credential plaintext and keeps recoverable safe state` now exercises the same `SessionManager` write path and inspects the actual JSON file. It checks nested object/array values, message text, encoded tool arguments, and multiple synthetic values.

## Persistence-path inventory and applicability

| Writer | Input and source | Durable representation and recovery | PERS-002 disposition |
|---|---|---|---|
| `SessionManager` → `DurableStateManager.saveTaskState()` | Session/task state, including arbitrary messages, notes, plan, candidate and validation metadata | JSON in the configured session/state directory; loaded by `loadTaskState()` / `loadSession()` | Applicable and reachable. The shared state serializer now irreversibly redacts classifier matches before JSON serialization. Legacy plaintext is rewritten before successful recovery. Identity fields that would be changed are rejected rather than persisted under altered identity. |
| `CheckpointManager` Git path | Tracked/index/worktree changes and checkpoint name | Git checkpoint ref plus JSON metadata | Applicable. Changed paths, staged blobs and worktree bytes are classified before `git stash create` or ref creation. If inspection fails, checkpoint creation fails closed. A clean checkpoint records the existing HEAD reference. |
| `CheckpointManager` non-Git path | Workspace files and names | Snapshot copy plus JSON metadata | Applicable and source-of-truth content is needed on restore. Rather than redact and create an incomplete snapshot, creation refuses when classified content is present. Each file is scanned and the exact scanned bytes are copied; partial output is removed on failure. |
| `KnowledgeGraph` | Learned key, value and tags; callers can provide arbitrary strings | `.nexus/knowledge.json`; entries reload after restart | Applicable as persistent project knowledge/cache. A protected copy is written; old plaintext entries are migrated before they are made available after load. Ordinary knowledge is retained. |
| REPL input history | User-entered command text | History file, line append; loaded at startup | Applicable transcript-like persistence. Each appended line is irreversibly redacted; legacy history is rewritten before returned history is accepted. Raw input remains available only to the live process memory. |
| Session transcript export | Current session messages and metadata | User-selected JSON or Markdown file | Applicable publication/export copy. Both formats pass through the same canonical durable redaction before atomic replacement. |
| `FlightRecorder` and audit writer | Execution events, arguments/results/errors and audit records | `.nexus/flights/*.flightlog` and audit records | Already covered by operator-accepted CRED-003 at implementation HEAD `a285204cb83d08b6c6db7cb5e482064768479f54`; not reopened here. Its accepted qualification demonstrates pre-write irreversible redaction using the WP-05 classifier. |
| Crash-report writer | No crash-report persistence writer was found in the reviewed CLI source paths | None identified | No reachable writer to remediate or claim as tested. This is a source-path finding within the reviewed CLI scope, not a universal stack-trace guarantee. |
| MCP connection configuration | Explicit operator-provided server configuration, including configured environment values | `~/.config/nexus/mcp.json` | Not a session, transcript, checkpoint, cache, audit, flight or crash artifact. It is explicit connection configuration rather than incidental state capture; this task does not redesign credential configuration storage. No claim is made that this separate configuration file is a protected vault. |
| Static templates, theme choice, dummy browser output, worktree exclude, benchmark scorecard | Generated constants, a theme name, test image, repository control line or explicit scorecard destination | Individual files | Not state/transcript/checkpoint/cache persistence under this requirement; inspected writer sites contain no arbitrary session or tool payload. |

## Correction architecture and protection mode

`cli/src/core/persistence_protection.ts` establishes a shared pre-write boundary. It delegates to `InformationFlowBoundary.redactForDurablePersistence()`, which reuses the accepted WP-05 DATA-001 classifier and irreversible redaction behavior. It does not create token mappings or claim encryption. Telemetry retains its existing `redactForTelemetry()` API and behavior through the same classifier/redaction implementation.

For session, knowledge, history and exported transcript data, the classified value is not required as a credential after restart. The approved credential source remains the existing authorized configuration/environment path. Those copies therefore retain record structure and ordinary text while replacing classified plaintext irreversibly. No existing durable secret vault/key-management system is available or needed for these session transcript/cache copies. This implementation introduces no cryptography.

Checkpoint file content has different semantics: it is source-of-truth workspace state and may need exact restoration. It is therefore not destructively redacted. When sensitive content is present, checkpoint creation is refused before a durable reference/copy is created. This exposes the inability to checkpoint as an explicit error and preserves the live workspace unchanged.

`DurableStateManager.saveTaskState()` protects the complete state object before serialization and disk write. The caller's live object is not replaced by the redacted copy. State identity fields cannot be silently rewritten; an identity-field match or classifier/serialization failure prevents the write. Older plaintext state is protected and atomically rewritten before the protected representation is returned from recovery. Malformed JSON, unsupported schema and identity/workspace mismatches continue to fail closed under the accepted state contract.

Text-file migrations and exports use a temporary file followed by rename. REPL line history uses a pre-append sanitizer. Protection failures return bounded generic errors and never include the classified input in diagnostics. No success is reported for a failed protection write.

## Disk-level and recovery evidence

The focused tests in `cli/test/persistence_protection.test.ts` establish:

- SessionManager persists nested message and tool-call structures with synthetic GitHub-style, OpenAI-style and bearer values absent from the actual disk bytes; redaction markers and non-sensitive structure remain.
- Reopening the session recovers its ordinary title, plan details, message count, tool invocation identity and redacted sensitive text.
- Loading a legacy plaintext session rewrites the disk representation before returning the protected state.
- Knowledge graph values are redacted on disk and remain available in redacted form after reconstruction.
- Git checkpoints refuse sensitive changed content before creating a checkpoint ref or metadata; ordinary tracked changes remain checkpointable without altering the worktree.
- Non-Git checkpoints refuse sensitive file content without leaving a partial snapshot; ordinary files remain materially correct in a snapshot.
- REPL history append keeps live input in memory while writing only a redacted durable line; legacy history is migrated before returning it.
- A classifier/protection failure refuses durable task-state persistence and leaves neither target nor temporary file.
- Ordinary transcript export data remains parseable and materially intact around the redaction marker.

The original defect reproduction was performed before implementation using synthetic values and actual disk reads. Post-correction disk checks inspect the durable artifacts rather than only in-memory objects.

## Authority, recovery and limitations

Existing WP-07 regression tests continue to cover task/session binding, interrupted-operation detection, candidate freshness, stale validation invalidation, worktree binding and non-resurrection of authority. The persistence change preserves those state fields when the classifier does not identify them and refuses to persist if a protected value collides with task identity. It does not alter authority admission, egress routing, token scope, or candidate validation logic.

The checkpoint behavior intentionally reports failure when exact source-of-truth content cannot safely be copied. MCP server configuration is explicitly outside the enumerated incidental persistence paths and remains an operator-managed configuration surface. No crash-report persistence writer was found in the reviewed CLI sources. These are bounded scope statements, not claims of global process-memory or stack-trace secrecy.

## Verification record

- Focused PERS-002 and directly affected state/session/checkpoint/knowledge tests: 22 passed.
- `npm --prefix cli run build`: passed after the final source edits.
- Canonical `npm --prefix cli test`: passed; 208 tests, 0 failures, natural exit. An earlier run reported one UI-006 failure; focused UI-006 and the subsequent full canonical run passed.
- `make test`: passed; 13 Rust unit tests, 2 Rust integration tests, and all 208 CLI tests passed with natural exit.
- `bash scripts/security_gates.sh`: passed; Node audit reported 0 vulnerabilities, RustSec scan reported 0 known vulnerabilities across 92 packages, credential scan was clean, and diff hygiene passed.
- Independent adversarial qualification: pending.

This evidence records remediation work only. It does not claim operator acceptance or Issue #12 closure.
