# PERS-002 Durable Persistence Protection Evidence

## Normative contract

The exact Phase 2 requirement is:

> Nexus MUST NOT create uncontrolled, unredacted durable copies of credentials or classified sensitive data through session transcripts (`~/.nexus/sessions/`), flight logs (`.nexus/flights/`), audit logs, checkpoints, caches, or crash artifacts.

Its acceptance criterion is:

> Serialization owners (`SessionManager`, `FlightRecorder`) MUST apply sensitive-data protection policies prior to writing records to disk.

Phase 3 maps durable state to `DurableStateManager` and `SessionManager`; Phase 4 maps PERS-002 to WP-07 / INC-08. Accepted WP-07 evidence covered interrupted-operation cleanup and recovery, but did not send arbitrary nested `SessionManager.saveSession()` content through a disk-level secret test. Final Issue #12 reconciliation found this uncovered writer.

## Original defects

Before correction, an isolated temporary `SessionManager` received synthetic credential material inside nested session messages. Its real `saveSession()` path serialized the content through `DurableStateManager`, and a disk read found the synthetic plaintext in the session JSON. Separate isolated disk reproductions found sensitive values in a `KnowledgeGraph` value and in Git and non-Git checkpoint content. Only synthetic fixtures were used.

## Persistence-path inventory

| Writer | Reachable input and durable form | Protection disposition |
|---|---|---|
| `SessionManager` → `DurableStateManager` | Arbitrary messages, notes, plans and state fields; JSON state/session files | Applicable. The state object is classified and irreversibly redacted before serialization. Identity values cannot be rewritten. |
| Git `CheckpointManager` | Git index/worktree source content; refs and metadata | Applicable. Changed/index/worktree bytes are checked before creating a ref. Inspection errors fail closed; staged deletion without an index blob is handled explicitly. |
| Non-Git `CheckpointManager` | Workspace files and names; snapshot copy and metadata | Applicable. Sensitive source-of-truth content causes checkpoint refusal so the snapshot cannot silently lose required bytes. Ordinary snapshots remain intact. |
| `KnowledgeGraph` | Caller-provided key, value and tags; `.nexus/knowledge.json` | Applicable cache/knowledge state. Values are irreversibly protected before write and on legacy recovery. |
| REPL history and JSON/Markdown exports | User/session content; history or user-selected export | Applicable transcript copies. Append and export writes use the canonical durable sanitizer; old history is migrated before returning it. |
| FlightRecorder and audit writer | Execution arguments, results, errors and audit records | Covered by operator-accepted CRED-003 at `a285204cb83d08b6c6db7cb5e482064768479f54`; not reopened. Accepted evidence covers pre-write irreversible redaction. |
| Crash reports | No crash-report persistence writer found in reviewed CLI source paths | No reachable writer identified. This does not claim a universal stack-trace or process-memory guarantee. |
| MCP connection configuration | Explicit server configuration, possibly including configured environment values; `~/.config/nexus/mcp.json` | Separate operator-managed connection configuration, not incidental transcript/checkpoint/cache/audit/flight/crash persistence. This task does not claim it is a protected vault. |
| Static templates, theme choice, dummy browser output, worktree exclude, benchmark scorecard | Bounded constants or explicit output | Reviewed writers do not accept arbitrary session/tool payload as PERS-002 state. |

## Protection design

`cli/src/core/persistence_protection.ts` reuses `InformationFlowBoundary` and the accepted WP-05 classifier. Session content, knowledge, history and exports use irreversible redaction; no reversible token map, durable secret vault, or new cryptography is introduced. Checkpoints refuse when exact source content cannot be safely copied.

Generic durable content has no path exception. The bounded typed-resource rule is implemented by runtime `WorkspacePath` values in `cli/src/core/workspace_path.ts` and the schema-aware `redactTaskStateForPersistence()` boundary:

- A `WorkspacePath` is created from the selected application workspace model. It must be absolute, already normalized, an existing directory, and pass a real-path check. Before persistence or recovery, the directory and its canonical real path are checked again. `SessionManager` receives a provider for the application's current selected workspace; it compares the persisted schema field to that independently established capability and refuses mismatches. Persisted JSON never creates a capability.
- `SessionManager` rejects a caller-supplied capability unless it matches the live application selection. `DurableStateManager` checks every path passed to save, load, or recovery against its configured selected capability set. Caller-supplied identities and recovery options cannot expand that set; persisted-workspace capability minting was removed.
- Runtime capabilities are frozen and branded in a module-private `WeakSet`; `assertCurrent()` rejects unbranded instances. This prevents ordinary property mutation or prototype-forged objects from changing or claiming the selected identity.
- The serializer preserves only exact top-level `workspacePath` / `workspace` identity values matching the supplied runtime capability. It never infers the type from a regex, prefix, suffix, entropy, `/tmp`, or path-like appearance. An untyped value in a field named `workspacePath` follows ordinary classifier behavior and cannot gain the capability from the property name.
- A finding other than `UNCERTAIN` from the canonical classifier blocks persistence even for a typed workspace. Thus deterministic, contextual and explicit sensitive findings take precedence. DATA-004 `UNCERTAIN` may be resolved only for the validated, schema-typed resource identity; arbitrary content retains ordinary protection.
- A positive credential in a selected workspace directory name is refused. A high-entropy-only path component is preserved only after typed path validation, because the accepted classifier labels it `UNCERTAIN`, not positively identified. A matching synthetic high-entropy value in message content remains redacted.
- A malformed, replaced, or unselected identity fails closed. The persisted value is the exact selected path; it is not normalized to a different directory, replaced with a process-local reference, or guessed during recovery.

For `SessionManager` recovery, the persisted session workspace must exactly match the application's current selected `WorkspacePath`; loading a session cannot select or broaden the workspace. The operator-selected `--workspace` (or current application configuration) establishes this identity before the file is read. This path typing does not restore prior execution authority. Existing current-configuration authority, candidate revalidation, stale-receipt invalidation, interrupted-operation detection and non-resurrection checks remain in force.

If initial state protection fails, `AutonomousAgent` performs no state write and exposes a fixed, secret-free recovery-unavailable status through `getInitialStatePersistenceFailure()`. Authorized local execution continues as before; later checkpoint failure remains an explicit write error. The status does not claim that durable recovery succeeded.

## Disk-level adversarial evidence

`cli/test/persistence_protection.test.ts` verifies actual files and recovery:

- The original `SessionManager` path protects nested message/tool-call credentials; synthetic GitHub, OpenAI-style and bearer plaintext is absent from disk, redaction is present, and ordinary structure is recovered.
- A valid selected temporary workspace path survives serialization and a fresh `DurableStateManager` restart exactly.
- A selected symlink alias is preserved only while its real path remains the one validated; replacing the alias target blocks persistence. Unnormalized and malformed workspace paths are rejected.
- A path value with the old generated-name shape is refused when it has no runtime `WorkspacePath` capability. The old shape-based exception is absent.
- A session file whose workspace points to another existing directory cannot mint typed identity or expand the application's selected workspace; it is rejected during load/recovery.
- A caller-minted capability for another existing directory is rejected by both session and task-state save before any durable artifact is written; the test inspects both target locations.
- Re-minting a capability for a retargeted symlink alias cannot replace the state manager's originally selected resource; the configured capability is revalidated before each protected write, and no record is created.
- Reflective changes to the selected identity's path fields fail, and a prototype-forged identity is rejected before disk write.
- A typed workspace path containing synthetic bearer, GitHub, OpenAI-style, contextual API-key, AWS, Google, HuggingFace or Slack classifier matches is refused before a state file is created. PEM content is positively classified; its newline/path separators cannot represent one directory component.
- A typed high-entropy-only path component is preserved after validation because the canonical classifier labels it `UNCERTAIN`; the same fixture in arbitrary nested message content is redacted.
- Classifier failure produces no state file or temporary file. The agent reports a generic initial persistence failure without including the synthetic credential and preserves authorized local execution.
- A legacy plaintext session is rewritten before successful load. Classified task identity fails recovery without writing a shadow record; the original legacy file remains for operator remediation because remapping or deleting its identity would silently lose state.
- Knowledge values are redacted on disk and recovered in redacted form.
- Git and non-Git sensitive checkpoints are refused without a partial copy; ordinary checkpoints work. Git staged deletion and unexpected index-inspection failure have focused coverage.
- REPL history and JSON/Markdown exports use protected writes while preserving ordinary content.

WP-07 regression tests cover candidate freshness, offline mutation, stale validation, worktree binding, interrupted state and authority non-resurrection. The decisive `system_journey` now passes with the selected workspace capability and its recovery path intact.

## Verification record

- Independent review found two MATERIAL provenance bypasses: a persisted session path could mint a capability, and callers could override selected paths at save/recovery. Both were corrected; new regressions verify persisted JSON is comparison-only and caller-supplied overrides fail before disk writes.
- Independent review found a third MATERIAL bypass: a reminted capability with the same symlink alias string could follow a changed target. Authorization now revalidates configured capabilities at each operation; the disk-level retarget/remint regression confirms no write.
- Independent review found a fourth MATERIAL bypass: the exposed TypeScript object could be mutated at runtime or forged by prototype. Runtime freezing and private branding now reject both; a disk-level regression covers mutation and forgery.
- Focused persistence, WP-07, flight/audit and `system_journey` regression after all four corrections: **41 passed, 0 failed**.
- `npm --prefix cli run build`: passed after the final source changes.
- Focused persistence, WP-07, flight/audit and `system_journey` regression: **41 passed, 0 failed**.
- `npm --prefix cli test`: **223 passed, 0 failed**, natural successful termination.
- `make test`: Rust **13 unit + 2 integration** tests and CLI **223 tests** passed; natural successful termination.
- `bash scripts/security_gates.sh`: passed; Node audit found 0 vulnerabilities, RustSec found 0 known vulnerabilities across 92 packages, credential scan was clean, and diff hygiene passed. The same gates also passed inside `make test`.
- Independent qualification: final review of the implementation diff is in progress; see `docs/PERS002_INDEPENDENT_QUALIFICATION.md` after that review is complete.

This evidence supports PERS-002 implementation review only. It does not claim operator acceptance or Issue #12 closure.
