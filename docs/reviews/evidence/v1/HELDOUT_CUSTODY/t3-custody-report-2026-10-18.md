# Held-out T3 long-task corpus (`heldout-t3`): custody and seal record

| | |
|---|---|
| Date sealed | 2026-10-18T10:42:00Z |
| Custodian | `opencode` primary session (custodian/integrator role; never authored a task) |
| Sealed manifest | `eval/heldout-t3-manifest.json` — SHA-256 `dcbd794ed2998423787fdead4957b38b0c4a8a641855d87304d065d01c3fae37` |
| Store (private; not in the repository) | `/home/mike/nexus-heldout-t3` (`root:root`, mode `0700`; `tasks/` and `reference/` `root:root`, mode `0500` read-only) |
| Requirement | `REQ-QUAL-109` (`DEC-05`, `ACCEPTANCE.md` §6.3, `DECISIONS.md` X2): 8 T3 long tasks × 5 runs, `steps ≥ 60`, `≥ 2` compactions, scripted steering (`≥ 95%`), closing fact-sheet probe (`false-absence = 0`, `false-presence = 0`) |

This record contains approved metadata only. It does not contain task objectives, steering texts, fact statements/paths, fixtures, `blackbox-v1` oracle cases, or reference patches.

## 1. Corpus identity and composition

| Property | Value |
|---|---|
| Tasks | 8 (`t3-js-bugfix-01`, `t3-js-debug-01`, `t3-js-feature-01`, `t3-js-refactor-01`, `t3-py-bugfix-01`, `t3-py-debug-01`, `t3-py-feature-01`, `t3-py-refactor-01`) |
| By class | bugfix 2, debug 2, feature 2, refactor 2 |
| By oracle runtime | Node.js 4 (`node`), Python 4 (`python3`) |
| Oracle protocol | `blackbox-v1` (`casesFile: "oracle/cases.json"` outside `repo/`) + `regression.command` |
| Steering per task | 3 items (`file-unchanged`, `file-absent`, `command`) with verified baseline preconditions |
| Fact sheet per task | ≥ 4 facts with both `expected: "present"` and `expected: "absent"` |
| Hash scheme | `taskSha256` = SHA-256 of raw `tasks/<id>/task.json` bytes; `treeSha256` = `taskTreeDigest` (`nexus-task-tree-v2\0` framing matching `eval/validate.mjs`) |

## 2. Authorship and independence

| Partition | Author | Session / provider | Context and access | Outcome |
|---|---|---|---|---|
| Batch T3A (4 tasks: `t3-js-feature-01`, `t3-js-refactor-01`, `t3-py-bugfix-01`, `t3-py-debug-01`) | `author-t3a` | OpenAI Codex `exec` 0.163 (`gpt-6-luna`), fresh session `01a14e8f-a609-7790-8523-3e24f92d5c1c`, launched with `--disable memories --disable hooks --disable skill_search -c mcp_servers={}`, cwd `/home/mike/nexus-heldout-t3` | Inputs limited to store `AGENTS.md`, `T3-SPEC.md` (`eval/T3.md` at `12edf74`), `CONTRACT.md`, `ASSIGNMENT-T3A.md`, `bin/check_t3.mjs`. Custodian audited all 12 `exec` lines of `/tmp/opencode/author-t3a.log`: zero out-of-contract reads. | 4/4 accepted |
| Batch T3B (4 tasks: `t3-js-bugfix-01`, `t3-js-debug-01`, `t3-py-feature-01`, `t3-py-refactor-01`) | `author-t3b` | OpenAI Codex `exec` 0.163 (`gpt-6-luna`), fresh session `01a14e8f-a60d-74b1-bc58-7dbb1661ead1`, same clean flags and cwd | Inputs limited to store `AGENTS.md`, `T3-SPEC.md`, `CONTRACT.md`, `ASSIGNMENT-T3B.md`, `bin/check_t3.mjs`. Custodian audited all 12 `exec` lines of `/tmp/opencode/author-t3b.log`: zero out-of-contract reads. | 4/4 accepted |

Neither implementation agents (`claude-code`, `codex-lead`) nor the custodian (`opencode`) authored any T3 task.

## 3. Custodian validation and DAC isolation

Every task was validated by the custodian across 2 independent rounds (`bin/check_t3.mjs`):
1. Schema, steering precondition (`file-unchanged` and `file-absent` paths exist in baseline `repo/`), fact sheet (`expected: "present"` and `"absent"` both represented), and `blackbox-v1` oracle structure verified.
2. Fresh git workspace staged from `tasks/<id>/repo/`; baseline `regression.command` passes (exit 0); baseline `blackbox-v1` oracle fails.
3. Reference patch `reference/<id>.patch` applies cleanly (`git apply`); post-patch `blackbox-v1` oracle passes all cases; post-patch `regression.command` passes (exit 0).
4. Post-patch steering constraints hold (`file-unchanged` byte-identical to baseline, `file-absent` removed, `command` exits 0).
5. Post-patch fact existence matches `expected` for every fact (`0` false absences, `0` false presences).

After sealing (`SEALED-heldout-t3-manifest.json`, SHA-256 `dcbd794ed2998423787fdead4957b38b0c4a8a641855d87304d065d01c3fae37`), `/home/mike/nexus-heldout-t3` was locked to `root:root` mode `0700` with `tasks/` and `reference/` mode `0500` read-only. Verified as uid `mike` (`1000`): `ls /home/mike/nexus-heldout-t3` fails with `Permission denied`.
