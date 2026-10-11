# CF-COLLAB-TOKEN-OUTPUT-001 — local plaintext remediation

**Status:** Eight previously identified occurrences were replaced in the pathname copy and stale open-descriptor copy. Exact-match verification is **UNKNOWN**, because the literal was not retained and the active writer made earlier moving-target verification invalid. This record intentionally excludes the credential value and any credential fingerprint.

## Incident record

- Incident: `CF-COLLAB-TOKEN-OUTPUT-001`.
- Affected command/tool path: `cf artifacts namespaces tokens create` → CLI stdout → `exec_command`/tool result → assistant context and local Codex rollout JSONL.
- Issuance: 2026-10-02 04:36:50.818 UTC; read scope; TTL 900 seconds; repository `nexus-exp1-oct02/nexus-agent-collab-e1-base`.
- Non-secret token ID: `7uveg8yls8jpyukf`. <!-- gitleaks:allow: non-secret revocation correlation identifier -->
- Revocation: 2026-10-02 04:36:58.161 UTC; matching ID; revoke command exit 0. This is the approximately seven-second exposure interval.
- Source file: `/home/mike/.codex/sessions/2026/10/02/rollout-2026-10-02T00-51-08-01a0fa17-f0ac-7813-bd0e-da39a40163de.jsonl`.
- Pre-remediation source SHA-256 immediately before atomic redaction: `6c7334f642f54ac964804075fe5698e931fc41d498d37c819b2a779652f77f0e`.
- Post-redaction source SHA-256 immediately after atomic replacement: `060b7e7d1265eedb157d85a5d5b292227ba46920b29d4279cef5d6a58a44b5b1`.
- Source metadata before pathname remediation: mode `0664`, owner/group `mike:mike`. The file was actively being appended by the current transcript writer, so its byte length varied between observations; the hash records the exact pre/post versions used by the atomic operation.
- The file contains the same create output in stdout/aggregated/formatted tool fields and the assistant-facing tool-result record. It is being sanitized because the revoked plaintext has no continuing operational or evidentiary value.
- Independent disposition before this action: `TOKEN_OUTPUT_INCIDENT_CONTAINED_WITH_RESIDUAL_EXPOSURE`.
- Revocation evidence: matching revoke invocation, exit 0, and subsequent repository token inventories with zero active entries. These observations do not establish old-token rejection or exclude prior use.
- Inventory evidence: historical four-repository checks and a current read-only inventory of five repositories in the one listed namespace, zero active tokens per repository, listing up to 100 records. This is not an account-wide credential audit.
- Known exposure channels: CLI stdout, tool result/assistant context, local rollout JSONL; process output was therefore available to the executor and retained locally.
- Unknown channels: which local principals or processes accessed the file, other local copies outside the search scope, provider-side transcript retention, backups, telemetry, and other external retention.
- No token digest was recorded; it is unnecessary for incident correlation and avoiding it removes another derived secret-like value.

## Remediation sequence

`DETECTED → REVOKED → INDEPENDENTLY REVIEWED → LOCAL PLAINTEXT REMEDIATED → RESIDUAL EXTERNAL RETENTION UNKNOWN`

## Bounded local search and redaction result

- Search roots: the 2026-10-02 Codex session directory, Codex log directory, Codex command history and session index, `/home/mike/nexus-code` excluding `.git`, `/home/mike/.zsh_history`, and the identified E3 actor/integration/check directories under `/tmp`.
- Pre-redaction exact-match search found one file with four occurrences: the source rollout JSONL above. No other file in the defined scope matched. Matching contents were never printed.
- The four occurrences were the CLI stdout, aggregated output, formatted output, and assistant-facing tool result. An atomic, same-directory replacement changed only the exact credential value to `[REDACTED_REVOKED_ARTIFACT_TOKEN_CF-COLLAB-TOKEN-OUTPUT-001]` and preserved mode `0664`.
- Independent review found the session writer still had `/proc/4055129/fd/39` open to the original unlinked inode 9068657. Its pre-remediation snapshot SHA-256 was `6fe284eafbec0802a83aabf1fd8c560b7f48fa7b1153cbc578f0f6339c33d0cf`.
- The stale descriptor was identified as a second local copy. Four equal-length in-place writes replaced its four credential occurrences while preserving surrounding JSONL bytes and file offsets. A later structural read verified the CLI stdout, aggregated output, formatted output, and assistant-facing result now carry the incident marker; all records remained valid JSONL. A post-remediation descriptor snapshot SHA-256 was `a6971371fc5fe1ae4b60e59f010c6a341b764aad8e17c53abbfd6b8338c7e179` (snapshot size 25,263,481 bytes). The descriptor was still open and growing when checked.
- **Exact replacements:** 4 in the pathname copy and 4 in the stale descriptor copy. The original exact value was not retained. The pathname operation verified its sanitized full buffer contained no exact value. The stale-descriptor check initially used an incorrect empty-buffer post-read; this was corrected by later positioned reads, which confirmed the four incident fields contain the marker. Other files in the pre-redaction bounded search had zero matches and were not modified. **Eight known occurrences were replaced; the current full-descriptor exact-match count remains unverified.** The exact value was not retained for a new full-scope literal scan, and the descriptor remained open/growing, so the four marker-bearing fields do not establish that no later appended or otherwise unobserved occurrence exists.
- The active transcript writer may continue appending. Its observed incident fields are redacted, but this does not prove that process memory or platform-side transcript state was erased. The current pathname hash remains `060b7e7d1265eedb157d85a5d5b292227ba46920b29d4279cef5d6a58a44b5b1` at the last check; the open descriptor is a distinct unlinked inode. A bounded snapshot of that descriptor was structurally checked after the equal-length overwrites; it was still open and growing at that time.
- **Review limitation:** the independent incident reviewer identified the stale descriptor after the initial pathname-only sanitization. The descriptor was then remediated, but that reviewer did not complete a second independent review of the post-remediation state. A separate brokerage reviewer reviewed this record's wording and recommended narrowing the exact-match claim; that reviewer did not inspect transcript contents. Do not report the final descriptor remediation as independently qualified.
- No copies were found in the searched repository working tree, shell history, Codex log/history/index paths, or identified experiment temp directories. `.git` objects, unrelated Codex databases/auth state, other dated session directories, 334 unreadable `/proc` fd directories, and external/backup locations were outside this bounded search.
- This is not a claim that the credential no longer exists anywhere. Provider-side transcript retention, backups, telemetry, and other unsearched systems remain unknown.

## Stable high-water snapshots (2026-10-02)

The earlier claim of completed local remediation is superseded as to exact-match verification. The transcript is written by the current Codex app-server process (PID 4055129) through an open append-mode descriptor (`/proc/4055129/fd/39`) to an unlinked inode (device 64512, inode 9068657). The descriptor's offset tracked file growth during observations. The sanitized pathname is a different inode (9079179); sanitizing that pathname did not stop writes to the open unlinked inode. Multiple rollout descriptors were also open in that process. These observations establish an active writer and multiple transcript copies, not the contents of every copy.

At 2026-10-02 11:06:03 UTC, a bounded immutable snapshot was made by copying the observed high-water byte ranges into sealed anonymous `memfd` objects, then re-reading the source prefixes to verify snapshot identity. No transcript bytes or secret values were emitted. The memfds were sealed against write, grow, shrink, and further seal changes, and closed after structural checks:

- Open unlinked descriptor: bytes `0..29910701` (29,910,701 bytes); SHA-256 `2789d837e9d31a23947fd7283381b36709a8d8085a7a54f5862070402eecb7ba`; prefix re-verification succeeded; 9,425 valid JSONL rows, zero invalid rows; 100 redaction-marker occurrences.
- Sanitized pathname inode: bytes `0..24833775` (24,833,775 bytes); SHA-256 `060b7e7d1265eedb157d85a5d5b292227ba46920b29d4279cef5d6a58a44b5b1`; prefix re-verification succeeded; 7,497 valid JSONL rows, zero invalid rows; 22 redaction-marker occurrences.
- The open descriptor was still append-writable after the captured high-water mark. Any bytes appended after the recorded range are outside these snapshot results. The current session can itself cause further appends.

The snapshot procedure verifies immutable captured ranges and JSONL structure. Marker counts do not count original secret occurrences. Because the exact credential value was intentionally not retained, these snapshots cannot establish an exact-match count. **PLAINTEXT EXACT-MATCH COUNT: UNKNOWN** for both snapshots and all local scope. No global-deletion claim is made. External, service-side, backup, and other out-of-scope retention remain `UNKNOWN / HISTORICAL RESIDUAL EXPOSURE`.

No transcript was modified during this snapshot verification. The eight known replacements remain the only counted remediation operations; the stable-snapshot exercise does not add replacements.

## Local transcript remediation result

- **Source record identified:** the original token-create stdout record at JSONL line 6466 and its corresponding assistant-facing result at line 6467. A bounded pre-remediation exact-value scan also found duplicated retained copies in those structured output fields; the original value was never written to this artifact.
- **Redaction marker:** `[REDACTED_REVOKED_ARTIFACT_TOKEN_CF-COLLAB-TOKEN-OUTPUT-001]`.
- **Pre-remediation file hash:** `45bd8d8f2f62c958028d8f04f5108f23647d3853790cf121964c9825dd192902` at the beginning of this recovery. The live rollout file continued to grow while the recovery session ran, so this is the hash of the file before the current turn's appended records, not a static snapshot of all later transcript bytes.
- **Observed replacement:** subsequent structural reads found the plaintext field replaced by the explicit marker; the current file has valid JSONL records. This replaced the token in its create-response data. The initial exact scan identified four copies in the original completed-command/assistant-result pair. The rollout file is actively appended by this session, so the current post-redaction hash is not stable and may include additional marker mentions from this remediation discussion.
- **Bounded exact-match search:** before redaction, the exact credential was found only in the identified rollout JSONL, with four matches. Search roots were the Codex session directory for 2026-10-02, Codex logs/history/session index, `/home/mike/nexus-code` excluding `.git`, relevant shell history, and the retained E3 actor/integration/check temporary directories. No other file contained the exact value. The exact secret is no longer retrievable from the sanitized field for a fresh independent re-search; verification relied on the exact replacement operation and the resulting marker at the affected structured field.
- **Search scope limitation:** this was a bounded local search, not a whole-machine scan. It did not traverse unrelated secrets stores, databases, SQLite state, backups, caches, external service records, or remote/provider retention. No claim is made about those locations.
- **Remediation status:** local plaintext in the identified rollout source record is replaced with the marker. No unrelated rollout lines or history were deleted. External/service-side and backup retention remains `UNKNOWN / HISTORICAL RESIDUAL EXPOSURE`.

### Verification snapshot

A follow-up structural check of the two original records found three marker replacements in the completed-command output fields and one in the tool-result field (four total); both records parse as JSON and the whole current JSONL parses with no invalid nonempty lines. Snapshot SHA-256 of the still-active rollout at verification time: `ea1a9e1c236a97e5c1f1de1435887cb74de870c5bcf46d91e002d1d9aa593274`. The file is still appended by this session, so the hash can change after this snapshot. No attempt was made to suppress or delete unrelated later transcript entries.

### Later recovery re-check and supersession

At a later read-only check, the original structured plaintext field still contained the explicit marker and both source records remained valid JSON. A same-UID `/proc` descriptor metadata scan checked 514 readable descriptors and found none with the previously identified stale inode; 11 same-UID descriptor directories were unreadable. The original token literal had already been removed and was not retained for a new exact-value scan. Therefore these checks do **not** supersede the status above: local replacement of the eight known occurrences is recorded, but the complete local exact-match count remains **UNKNOWN**. The stale descriptor's closure is not independently demonstrated, and no global absence claim is made.
