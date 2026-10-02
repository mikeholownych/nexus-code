# PERS-002 Independent Qualification

## Disposition

**INDEPENDENTLY VERIFIED FOR THE ACCEPTED BOUNDED OPERATING ENVELOPE; READY FOR OPERATOR ACCEPTANCE.** No unresolved MATERIAL finding remains in implementation `a2d3051adaf08af925d1ee6b2407f6a6b153b8cf`.

This qualification does not claim operator acceptance, PERS-002 closure, or Issue #12 completion. It evaluates the bounded typed-resource interpretation authorized for this remediation. It does not claim that pre-existing legacy files are retroactively clean or that all user-managed configuration is a protected vault.

## Candidate and review basis

- Starting remediation baseline: `a4f3e16bbdd149faf7338421b9a8fe8437ffdbaa`.
- Final implementation HEAD reviewed: `a2d3051adaf08af925d1ee6b2407f6a6b153b8cf` (commit `fix(nexus): bind durable workspace paths to selected identity`, parent `0e8b2d4c2815779b3ccb068b7fd73a638e303f65`).
- The implementation, tests, distribution output, and primary evidence are committed at this HEAD. This qualification artifact is reviewer-owned and remains uncommitted.
- I used synthetic credentials only. I did not modify implementation, tests, or primary evidence.
- Directly rerun: focused combined suite from `cli`: `./node_modules/.bin/tsx --test test/persistence_protection.test.ts test/state.test.ts test/system_journey.test.ts test/flight_sanitization.test.ts` — **41 passed, 0 failed**, natural exit. This run preceded the final commit; the final commit contains the reviewed branded/frozen capability code and matching focused tests.
- Owner-reported on the final committed version: `npm --prefix cli test` **223/223**, natural exit; `make test` exit 0 (Rust 13 unit + 2 integration and CLI 223); `npm --prefix cli run build` pass; `bash scripts/security_gates.sh` pass (npm audit 0, RustSec 0, credential/diff clean). I did not independently rerun these broad gates.
- Primary evidence artifact: `docs/PERS002_PERSISTENCE_PROTECTION_EVIDENCE.md`, SHA-256 `0530345f6f652a58d7527828ba4f29d9f0f3eca37ed01ec59838d47351464c40`.

## Normative contract and accepted interpretation

Phase 2 `docs/PHASE2_RECONCILED_REQUIREMENTS.md:461` states:

> Nexus MUST NOT create uncontrolled, unredacted durable copies of credentials or classified sensitive data through session transcripts (`~/.nexus/sessions/`), flight logs (`.nexus/flights/`), audit logs, checkpoints, caches, or crash artifacts.

Its acceptance criterion is:

> Serialization owners (`SessionManager`, `FlightRecorder`) MUST apply sensitive-data protection policies prior to writing records to disk.

Related PERS-003 at line 462 requires durable protection to preserve authorized local recovery and legitimate engineering work. Phase 3 maps persistence to `DurableStateManager` / `SessionManager`; Phase 4 maps PERS-002 to WP-07 / INC-08. Accepted WP-05 classifier semantics are reused via `InformationFlowBoundary`: deterministic/contextual positive sensitive findings are irreversibly redacted or refused where redaction would corrupt identity; durable telemetry/persistence uses irreversible redaction, with no reversible token map.

The final implementation applies the explicitly authorized bounded typed-resource rule: an application-selected, live-validated `WorkspacePath` may retain only its exact schema identity string where the canonical classifier reports `UNCERTAIN` and no positive sensitive finding. No ordinary string, field name, path shape, or entropy heuristic grants this treatment. The rule preserves required recovery identity while positive sensitive classifications take precedence.

## Adversarial findings and corrections

The review encountered four MATERIAL bypasses in earlier intermediate candidates. All were corrected in the final commit and covered by regressions:

1. **Shape-based temporary path exemption:** A synthetic path matching the former `nexus-...-<suffix>` shape was accepted unchanged despite canonical `UNCERTAIN` classification. The exception was removed; no shape-based exception remains.
2. **Persisted JSON minted session workspace identity:** Session loading previously derived the capability from the saved record. Final `SessionManager` requires the application's independently selected workspace provider and exact match (`cli/src/session.ts:199-212`).
3. **Caller-supplied capability overrode selected roots:** State/session writers previously accepted a different validated path argument. Final state manager checks each requested identity against the manager's configured selected identities and revalidates both (`cli/src/core/state.ts:426-436`); session save checks against the live provider (`cli/src/session.ts:55-60`).
4. **Retargeted symlink / runtime object mutation:** Final `WorkspacePath` instances are module-private WeakSet branded, frozen, and rechecked against current directory and real path (`cli/src/core/workspace_path.ts:4-39`). Re-minting after symlink retarget cannot authorize an alias not in the configured selection; reflective mutation and prototype forgery are rejected by disk-level regressions.

Current implementation has no unresolved MATERIAL finding in these areas.

## Reviewer questions

1. **What does PERS-002 require?** It prohibits uncontrolled unredacted durable copies through the enumerated persistence surfaces and requires SessionManager / FlightRecorder pre-write protection (`PHASE2_RECONCILED_REQUIREMENTS.md:461`).
2. **Did the original plaintext SessionManager defect exist?** The primary evidence records the synthetic nested disk reproduction (`PERS002_PERSISTENCE_PROTECTION_EVIDENCE.md:15-19`). I independently inspected the old write path and the corrected disk-level tests; I did not rerun the pre-fix baseline artifact.
3. **Does protection happen before state serialization/write?** Yes. `saveTaskState()` authorizes typed identities, protects the full record, validates identity fields, then JSON serializes and writes (`cli/src/core/state.ts:292-333`). Protection/classification failure occurs before target/temp-file creation.
4. **Do nested structures and arrays receive protection?** Yes. The canonical `InformationFlowBoundary` redactor traverses structured data; persistence tests exercise nested and multiple synthetic secrets and inspect disk (`cli/test/persistence_protection.test.ts`).
5. **Can legacy non-identity plaintext be migrated before a successful load?** Yes; changed legacy state is protected and rewritten before successful return (`state.ts:402-420`).
6. **Can an identity-bearing legacy record remain?** Yes. When redaction would alter an identity field, recovery fails before shadow-write and leaves the pre-existing file for operator-directed handling; the regression verifies this (`persistence_protection.test.ts:104-132`). This is a bounded legacy limitation, not a new-write bypass. No zero-plaintext claim is made for arbitrary pre-existing files.
7. **Are Git checkpoints checked before durable refs?** Yes. Changed paths, index, and worktree content are inspected before stash/ref persistence (`cli/src/checkpoint.ts:66-109`); inspection failures fail closed. Final tests include staged-deletion handling.
8. **Are non-Git checkpoints checked before copy?** Yes. Names and file bytes are scanned before copying; the checked buffer is copied and partial output is removed on failure (`checkpoint.ts:45-63,112-127`).
9. **Is KnowledgeGraph protected?** Yes. Save/load paths use the shared protection boundary and migration; tests inspect disk/reload (`cli/src/knowledge.ts:64-97`, persistence tests).
10. **Are REPL history and exports protected?** Yes. History append/migration and JSON/Markdown exports use pre-write protection (`cli/src/repl.ts:131-155,1336-1358`).
11. **Are flightlogs and audit logs protected?** Yes, via the separately accepted CRED-003 implementation: irreversible telemetry redaction before each durable append. This review inspected those paths and related regression; the primary CRED-003 qualification is separate.
12. **Can results, errors, metadata, or arbitrary nested state bypass?** They are values inside serialized records and pass through recursive protection. No alternate SessionManager serializer was found in the reviewed write-path search.
13. **Does sanitizer failure write plaintext?** No. State serialization fails closed before file creation; checkpoint and transcript helpers likewise refuse/clean partial outputs. Tests cover classifier failure and no-write behavior.
14. **Is useful non-sensitive state retained?** Yes. Negative controls and tests preserve ordinary titles/messages/plans, KnowledgeGraph values, safe checkpoints, and successful execution/recovery structure.
15. **Does typed path identity comply with classification semantics?** Under the authorized bounded rule, yes: only exact validated schema identity values get treatment for `UNCERTAIN`; all non-UNCERTAIN findings block, and identical secret-like strings in arbitrary message content receive normal redaction. `persistence_protection.ts:29-70` implements this boundary.
16. **Does the fix regress WP-05 execution semantics?** No change was found to token generation, destination trust, route fallback, token scope, or rehydration authority. The integration regression exercises authorized local restoration while persistence remains sanitized. The typed path interpretation is limited to durable resource identity and follows the explicit bounded authorization.
17. **Are other relevant durable writers missed?** Reviewed SessionManager/state, flight/audit, checkpoints, KnowledgeGraph, REPL history/exports, and related writers. MCP config (`cli/src/mcp.ts:566-584`) can store explicitly supplied connection configuration, including environment values, at the user's request; it is distinct from the PERS-002 enumerated transcript/flight/audit/checkpoint/cache/crash artifacts and is not a protected vault. Static template/theme/dummy-browser/worktree-exclude/scorecard writers inspected do not accept arbitrary task payload. This is a bounded CLI write-path inventory, not a universal claim about every external process or OS crash artifact.
18. **Final status?** `PERS-002 IMPLEMENTED AND INDEPENDENTLY VERIFIED FOR THE ACCEPTED BOUNDED OPERATING ENVELOPE; READY FOR OPERATOR ACCEPTANCE.`

## Findings classification

- **MATERIAL:** None unresolved in final HEAD. The four intermediate bypasses listed above were MATERIAL at discovery and are corrected in final commit with tests.
- **MINOR:** Existing legacy records whose identity fields themselves classify as sensitive cannot be transparently migrated without changing identity; they remain on disk and require operator-directed recovery. This limitation is disclosed in primary evidence and does not permit a new unsanitized write.
- **OBSERVATION:** Explicit MCP configuration persistence is outside this requirement's enumerated durable evidence/state scope and is not a protected vault. No claim is made that it is one.

## Verification boundary and final status

I inspected final committed code and tests, and directly reran the 41-test focused persistence/state/system-journey/flight suite. I personally reproduced the earlier unsafe temporary-path exemption on a prior intermediate diff; the exact exemption is absent in final HEAD. I reviewed final regressions for provider-bound load selection, caller-supplied identity mismatch, symlink retarget/remint, runtime mutation/forgery, nested secrets, classifier failure, checkpoint behavior, and local execution interaction. Broad canonical test/build/security results are owner-reported as listed above, not independently rerun.

**Final PERS-002 disposition: independently verified for the accepted bounded operating envelope; ready for operator acceptance.** This is not operator acceptance and does not close Issue #12.
