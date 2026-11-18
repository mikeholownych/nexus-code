# Skills Architecture Audit — Evidence Register

**Baseline:** `3c54e6014c2ea5281f642fdd53ac20605f2b24ae`  
**Worktree:** `/home/mike/nexus-wt/AUDIT_skills_architecture_2026-11-18`  
**Evidence root:** this directory  

All runs used isolated temporary `HOME` / `XDG_CONFIG_HOME` / `NEXUS_STATE_DIR`. No credentials or gateway tokens were read.

---

## 1. Environment

| Item | Value |
|---|---|
| Node | v24.11.1 |
| npm | 11.19.0 |
| rustc / cargo | 1.95.0 |
| Package versions | root/cli/core `1.2.1` |
| Commit | `3c54e6014c2ea5281f642fdd53ac20605f2b24ae` |
| Prior audit delta | 0 commits |

Raw: `raw/env.txt`

---

## 2. Source references (selected)

| Topic | Location |
|---|---|
| Skill load / trust | `cli/src/skills.ts:214-340` |
| Frontmatter ignore | `cli/src/skills.ts:342-346`, `347-386` |
| Sanitization | `cli/src/skills.ts:78-94` |
| Activate handler | `cli/src/core/spine_handlers.ts:677-704` |
| Capability def | `cli/src/core/capability_definitions/skill.ts` |
| Untrusted deny | `cli/src/core/dispatch_tool_call.ts:259-283` |
| Policy context (no isUntrustedSource) | `cli/src/core/dispatch_tool_call.ts:190-197` |
| Approval matrix | `cli/src/core/approval_policy.ts:20-88` |
| Authority default admit | `cli/src/core/authority.ts:522-596` |
| Confinement + fullAccess | `cli/src/core/authority.ts:602-704` |
| extractTargetResources | `cli/src/core/spine.ts:192-221` |
| ExecutionReceipt | `cli/src/core/spine.ts:95-128` |
| Needs-input binding | `cli/src/core/needs_input.ts:1-36` |
| Docs contract | `docs/SKILLS_AND_PLUGINS.md:28` |
| Frontmatter test | `cli/test/skills_agents_dir.test.ts:116-131` |

---

## 3. Test commands and results

### 3.1 Skill suite

```bash
export HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config" NEXUS_STATE_DIR="$HOME/.nexus"
cd cli && npx --no-install tsx --test \
  test/skills_agents_dir.test.ts \
  test/skill_injection.test.ts \
  test/skill_ranking.test.ts \
  test/skill_lookup.test.ts \
  test/skill_catalog_budget.test.ts \
  test/skill_catalog_resume.test.ts
```

| Metric | Result |
|---|---|
| tests | 57 |
| pass | 57 |
| fail | 0 |
| duration | ~58s |
| exit | 0 |

Artifact: `raw/skill-tests.log`

### 3.2 Auth / trust / injection related

```bash
# same HOME isolation
npx --no-install tsx --test \
  test/authority.test.ts \
  test/approval_policy.test.ts \
  test/workspace_trust.test.ts \
  test/spine.test.ts \
  test/injection_scanner.test.ts \
  test/injection_gate.test.ts \
  test/plugins_dirs.test.ts \
  test/readonly_mode_escalation.test.ts \
  test/security_gates.test.ts
```

| Metric | Result |
|---|---|
| tests | 72 |
| pass | 72 |
| fail | 0 |
| exit | 0 |

Artifact: `raw/auth-related-tests.log`  
Note: log contains tool UI “✖ Working” lines from mocked failures inside passing tests; suite summary is fail 0.

### 3.3 TypeScript / Rust

```bash
cd cli && npx --no-install tsc -p tsconfig.json --noEmit   # TSC=0
CARGO_TARGET_DIR=.../core/target cargo check --manifest-path core/Cargo.toml -q  # CARGO=0
```

Artifacts: `raw/tsc.log`, `raw/cargo-check.log`

### 3.4 Not executed

- Full `make test` / CI Node matrix (time/load; SUITE held only for targeted runs)
- Live gateway inference (GATEWAY claim not taken; not required for skills auth characterization)
- `gh issue list` (CLI unauthenticated)

---

## 4. Adversarial experiments

Harness: `adversarial/run_adv.mjs`  
Log: `adversarial/adv-run.log`  
JSON: `adversarial/adv-results.json`

| ID | Status | Observation summary |
|---|---|---|
| ADV-01 | BASELINE_OK | Frontmatter caps not on Skill; RO denies `rm -rf` |
| ADV-02 | BASELINE_OK | `/etc/passwd` read_file not confined |
| ADV-03 | CHARACTERIZATION | RO denies mutating shell; fullAccess admits |
| ADV-04 | CHARACTERIZATION | Catalog sanitized; activate body retains markers |
| ADV-05 | FINDING | No digest; sticky memory until refresh |
| ADV-06 | FINDING | Symlink retarget + outside target via global dir trusted |
| ADV-07 | FINDING | Receipt lacks skill fields |
| ADV-08 | CHARACTERIZATION | Note provenance restorable; activation = tool text |
| ADV-09 | FINDING | Delete sticky until refresh; no revocation hook |
| ADV-10 | CHARACTERIZATION | Injection scanner present; not skill-bound |
| ADV-11 | CHARACTERIZATION | Skills ≠ plugins; effect classes differ |
| ADV-12 | BASELINE_OK | needs_input id binds tool+args JSON |
| ADV-01b | CHARACTERIZATION | context_inject + isUntrustedSource only in unit policy |

Reproduction:

```bash
export AUDIT_WT=/path/to/worktree
export ADV_OUT=$AUDIT_WT/docs/reviews/evidence/v1/AUDIT_skills_architecture_2026-11-18/adversarial
export HOME=$(mktemp -d) XDG_CONFIG_HOME=$HOME/.config
cd $AUDIT_WT/cli && npx --no-install tsx $ADV_OUT/run_adv.mjs
```

---

## 5. Follow-up inventory / provenance (post-completion)

| Source | Result folded into audit |
|---|---|
| [prior-findings search](06517866-bc6b-46ce-98ce-7ea307003340) | No in-repo F-01–F-05 skills audit; PHASE2S F-ids are unrelated; SEC-05 historical trust gap is antecedent only |
| [skills architecture inventory](370450c7-7cf4-400e-acd3-e39aed9854be) | Confirmed path map; surfaced watcher⊂discovery gap (S-03), role/MCP omit `activate_skill` as compensating controls |
| Background shell greps `511022`–`511024` | SIGTERM; superseded by completed repo search |

---

## 6. Evidence integrity considerations

- Redact secrets if re-running with real HOME (this audit did not).
- Adversarial fixtures live under `/tmp` and audit HOME temps; not committed as skill content beyond the harness.
- Do not treat tool UI failure glyphs in logs as suite failures — use the `ℹ pass/fail` footer.
- Receipts and session JSON may contain skill bodies; stronger evidence capture must reuse existing redaction (`redactSecrets` / vault).
