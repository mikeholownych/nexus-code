# Nexus Code v1.0.0: release qualification procedure

This is the procedure that decides whether a release candidate (RC) may become v1.0.0. It defines:

- the environments;
- the workflow matrix;
- the evidence each step must produce;
- explicit pass/fail gates.

Three separate questions are judged and recorded separately:

| Question | Who answers it |
|---|---|
| **Implementation self-assessment** | Did the implementer's tests pass? |
| **Product qualification** | Did the RC meet these gates on real workflows? |
| **Independent acceptance** | Did a reviewer other than the implementer agree? |

A gate passes only on archived evidence bound to the source commit or installed RC artifact that the gate evaluates. Source-level evidence names the exact source commit; installed-RC evidence names both that commit and the installed package digest. A green test suite alone never qualifies the product.

## 1.1 Release-candidate lifecycle and evidence identity

The qualification sequence has three distinct stages. Passing an earlier stage is a prerequisite for the next stage, not a substitute for it.

1. **Source gates.** Before creating an RC tag, run G0–G4 automated gates and the required source CI on the exact commit intended for that tag. Record the full commit ID and check results. These checks evaluate source at that commit; they do not establish behavior of an installed package.
2. **RC artifact construction.** After the required owner authorization, create the version-matched RC tag on that exact source commit and use the repository release workflow to build and publish the RC artifacts. Record the workflow run, tag commit, artifact digests, and provenance. The workflow-produced artifacts are the candidates for qualification; a local build or a different commit is not interchangeable. RC artifact publication is not product qualification or final release acceptance.
3. **Installed-RC qualification.** Install the workflow-produced RC package using the documented procedure and run the applicable product, provider, task-quality, terminal, installation, and independent-acceptance gates in §§4–8. Bind each result to both the RC source commit and installed package digest. If a source change or rebuilt artifact changes either identity, rerun every affected gate against the new candidate and retain prior results as historical evidence.

The final G6 decision in §10 applies to promotion to the stable v1.0.0 release. It requires the applicable gates to pass for the accepted RC and the release authorization listed there. It does not waive source CI, artifact identity, installed-RC qualification, or any threshold. The final v1.0.0 tag and artifacts must follow the approved release workflow and satisfy its checks as well.

## 1. Rules

1. The RC is built and published by the release workflow from a clean tag. Its version is identical across all components (REQ-REL-103).
2. All qualification runs use the **installed RC package**, installed with the documented one-line command. They never use a checkout build. The only exception is CI unit and PTY suites, which run from source at the same commit.
3. Thresholds (DEC-05) are frozen before the first M5 run. A failing gate is fixed in code and the run is repeated as `rc.N+1`. A threshold is never relaxed after results are known.
4. Evidence goes to `docs/reviews/evidence/v1-qualification/<rc>/`. The directory contains:
   - `manifest.json`: commit, package sha256, environment, model fingerprint, dates;
   - raw outputs;
   - a `SHA256SUMS` file.

   Secrets are redacted before commit.
5. Any step that cannot run in the available environment is recorded as **NOT RUN** with its reason. A NOT RUN on a blocker gate fails the gate.

## 2. Environments

| ID | Environment | Used for |
|---|---|---|
| E1 | GitHub Actions: ubuntu-22.04 and ubuntu-24.04; Node 20, 22 and 24; pinned Rust | Unit, integration and PTY suites; packaging; reproducibility |
| E2 | Docker clean images: ubuntu:22.04, ubuntu:24.04, debian:12, fedora:40. Each with no Node, then with Node 20 and Node 22. Non-root user. | Installer, upgrade, rollback, uninstall, platform failure messages |
| E3 | Operator dev box: Linux x86-64, real terminals (xterm, kitty, tmux, VS Code terminal, GNOME Terminal) | Terminal matrix, live sessions |
| E4 | Homelab-ai gateway, the **only** inference path (DEC-16): direct, and through `eval/standalone/plain_proxy.mjs` | Task-quality runs, standalone qualification, T3/T4 |
| E5 | Cloud, small spend: ChatGPT sign-in (experimental tier) and OpenRouter with a pinned model; OpenAI and Anthropic keys if added | Provider verify; one live task per supported cloud provider |

## 3. Gate checklist (G0–G4: automated acceptance IDs)

Every ACC ID below is defined in the linked spec. The plan for each spec names the test that implements it. Source-applicable checks must pass in E1; environment-specific checks, including ACC-PROC-07 in E3, must pass in their declared environment. All run against the exact source commit intended for the RC tag, as specified in §1.1. These source gates do not replace the installed-RC qualification in §§4–8.

| Gate | Acceptance IDs | Spec |
|---|---|---|
| Safety | ACC-SAFE-01 to ACC-SAFE-10 | SPEC-01 |
| Process ownership | ACC-PROC-01 to ACC-PROC-08 (ACC-PROC-07 is the load test, run in E3) | SPEC-02 |
| Untrusted inputs | ACC-TRUST-01 to ACC-TRUST-09 | SPEC-03 |
| Continuity | ACC-CONT-01 to ACC-CONT-09 (ACC-CONT-10 is in §8) | SPEC-04 |
| Inference | ACC-INF-01 to ACC-INF-09 (ACC-INF-10 is in §4) | SPEC-05 |
| Packaging | ACC-PKG-01 to ACC-PKG-09 | SPEC-06 |
| Supply chain | ACC-SUP-01 to ACC-SUP-08 | SPEC-07 |
| Persistence | ACC-PER-01 to ACC-PER-07 | SPEC-08 |
| Governance | ACC-GOV-01 to ACC-GOV-06 | SPEC-09 |
| Verification | ACC-VER-01 to ACC-VER-09 | SPEC-11 |

### 3.1 Acceptance IDs defined in this file

These are retained commitments from REQUIREMENTS §2 and cross-cutting checks.

| ID | Check | Pass condition |
|---|---|---|
| ACC-TUI-STEER | PTY: submit a task; while a tool runs, type steering text and press Enter; also queue a steer before a cancel | Steering is applied at the next step boundary. Unapplied steering is returned to the composer. Nothing is dropped silently (existing `sidecar_steering_diff` plus PTY s6). |
| ACC-TUI-A11Y | PTY with `NO_COLOR=1` and with `TERM=dumb` at 40×14 and 100×30 | Zero colour SGR codes. Every state is distinguishable by glyph and word. Hints are complete at 40 columns (TUI-10). |
| ACC-SEC-JAIL | `core/tests` plus harness-core calls with `..`, absolute, symlinked-file, symlinked-dir and symlinked-parent payloads | Every one is refused (C §4 R1 set). |
| ACC-SEC-B6 | Re-run `docs/reviews/evidence/qualification_2026-10-12/repro/zz_trust_repro.test.ts`. Seeded-secret scan of `~/.nexus` and `.nexus` after a scripted turn. | Zero plaintext seeded secrets in durable stores or outbound bodies. |
| ACC-PRV-LIVE | `nexus providers verify --provider <p> -m <pinned model> -j` for each provider listed as supported (DEC-06) | `passed: true`. Receipts archived. |
| ACC-PLAT | E2 matrix, §7 | All rows pass. |
| ACC-QUAL-T2 | §6.1 + §6.4 | Thresholds met. |
| ACC-QUAL-T3 | §6.3 + §6.4 | Thresholds met. |
| ACC-QUAL-T4 | §6.2 + §6.4 | Thresholds met. |
| ACC-QUAL-SMOKE | `make test` includes the T1 self-test and the T4 smoke | Present and passing. |

## 4. Standalone and provider qualification (REQ-PRV-106, REQ-PRV-111, REQ-QUAL-107)

### 4.1 Clean-HOME procedure

1. `export HOME=$(mktemp -d)`.
2. Install the RC with the documented command.
3. Create `~/.config/nexus/config.env` containing only:
   - `LOCAL_LLM_ENDPOINT=http://127.0.0.1:<proxy>/v1`
   - `LOCAL_LLM_MODEL=<id as listed by the proxy>`
   - `LOCAL_LLM_API_KEY=local`

   No gateway token file, no homelab paths, no `NODE_*` overrides.
4. Start `node eval/standalone/plain_proxy.mjs --upstream <gateway> --token-file <operator token> [--emulate <kind>]`. The gateway token stays with the proxy and never reaches the Nexus HOME.
5. Run `nexus doctor --json` and archive it. It must report the server kind and context source with no `gateway` capability.

### 4.2 Standalone matrix

| Profile | What Nexus sees | Runs | Pass condition |
|---|---|---|---|
| P-plain | Bare OpenAI-compatible `/models` and chat. No tokenize, no capacity headers. | Standalone T2 subset (≥ 10 held-out tasks) × 3 runs; T4 classes 1, 3, 4, 7 × 3 | T2 correctness ≥ (gateway-direct T2 correctness on the same tasks − 10 pts). False VERIFIED = 0. T4 truthful = 100%. Context source reported as `client_default` or an operator override, with no error. |
| P-llamacpp | Emulated llama.cpp `/props` and overflow body | Same tasks × 1 run; plus the forced-overflow case (context limit set to 8k) | Context discovered from `/props`. Overflow gives one compact-and-retry, then success or an actionable error. |
| P-vllm | Emulated `max_model_len` and vLLM overflow body | Same as P-llamacpp | Same, with the context source `max_model_len` |
| P-ollama | Emulated `/api/show` and Ollama overflow body | Same as P-llamacpp | Same, with the context source `ollama_show` |
| Conformance | CI fixtures for llama.cpp, vLLM, LM Studio and Ollama shapes | CI | All pass (ACC-INF-01, -02, -05) |

ACC-INF-10 passes only when every row passes. The release notes state the scope in the form required by DEC-16.

### 4.3 Provider matrix (E5)

| Provider | Tier (DEC-06) | Required for v1.0.0 |
|---|---|---|
| OpenRouter, pinned model | Supported | `providers verify` PASS, plus one live small task (a §6-style bug fix) reaching a correct outcome |
| ChatGPT sign-in | Experimental | Verify PASS recorded (already PASS at db1ca55; repeat on the RC) |
| OpenAI API key, Anthropic | Experimental unless keys are added | If promoted: verify PASS plus one live task. Otherwise NOT RUN, and they are labelled experimental. |
| Copilot | Experimental | Not required |

## 5. Terminal acceptance (REQ-QUAL-108)

### 5.1 CI PTY suites (E1)

These must pass:

- `tui_approval_input_e2e`
- `tui_diff_e2e`
- `tui_maturity_e2e`
- `tui_model_picker_e2e`
- `tui_multiline_e2e`
- `tui_surface_e2e`
- new: `repl_approval_e2e`
- new: `process_lifecycle_e2e`
- new: `startup_unreachable_e2e`
- new: the package PTY smoke

### 5.2 Scripted PTY scenarios against the installed RC (E3, mock gateway)

These are ports of `evidence/D_pty/`.

| Scenario | Pass condition |
|---|---|
| s1 startup, unreachable endpoint | The endpoint is named, with a fix hint. The turn ends with guidance in ≤ 2.5 min. |
| s2 approval under continuous typing, paste and burst, at 40×14 | No decision is made by stray input. A deliberate key decides. |
| s3 completion | The outcome is shown in words: VERIFIED, REGRESSION_FREE or UNVERIFIED. |
| s4–s6 cancel and steer | Cancel is acknowledged within 1 frame and idle within 5 s. Steering is applied. |
| s7 resume | The prior conversation is shown. |
| s8–s9 cancel or quit during a tool | Zero surviving processes. |
| r1a / r1d REPL approvals | DENIED for a lone Enter and for a typed-ahead `y`. |

### 5.3 Manual real-terminal matrix (E3)

Terminals: xterm, kitty (kitty keyboard protocol on), tmux 3.x inside GNOME Terminal, VS Code integrated terminal, GNOME Terminal. Sizes: 80×24, 40×14, 200×60.

For each terminal × size, check:

1. Launch `nexus` (the TUI appears).
2. Approval panel. Type continuously across it. Paste 3 lines. Approve with a deliberate key.
3. Shift+Enter or Alt+Enter multiline.
4. Resize during streaming.
5. Esc during `sleep 30` (no survivors).
6. Ctrl-C twice (clean terminal restore: echo on, no stray escape codes).
7. NO_COLOR.

Record PASS/FAIL per cell, with a screenshot of the approval panel and the post-exit terminal state.

**Gate:** zero FAIL on checks 2, 5 and 6, which are safety checks. Other FAILs need a written disposition (fix, or a documented known limitation).

## 6. Task-quality qualification (REQ-QUAL-101 to REQ-QUAL-106, REQ-QUAL-109)

Environment: E4 (gateway direct), serial runs, with matched model fingerprint, budgets and env (REQ-QUAL-102).

### 6.1 T2 held-out (ACC-QUAL-T2)

- 40 sealed tasks. The manifest is committed before RC1, and authorship is recorded (agent-authored, DEC-05).
- 5 runs × {Nexus RC, Goose, OpenCode}.
- Before execution, freeze three qualification configs at `eval/configs/v1-t2-nexus.json`, `eval/configs/v1-t2-goose.json`, and `eval/configs/v1-t2-opencode.json`. Each must set `qualification: true`, identify the same model fingerprint and sampling settings, and record equal context/output and task budgets; the Nexus config must identify the installed RC and its package digest. Do not derive these files from the pilot configs by silently inheriting or changing settings.
- Set `T2_TASKS` to the custodian-approved, sealed task directory and `T2_OUT` to a new, empty, run-specific output directory. Do not use the disclosed `eval/tasks` development set as held-out evidence. Preserve all three outputs and their manifests; never reuse an output directory for a retry.
- Run each config serially, with identical task selection and five runs per task:

  ```bash
  set -euo pipefail
  : "${T2_TASKS:?set the sealed task directory}"
  : "${T2_OUT:?set a new unique output directory}"
  test ! -e "$T2_OUT"
  node eval/run.mjs --config eval/configs/v1-t2-nexus.json --tasks "$T2_TASKS" --out "$T2_OUT/nexus" --runs 5
  node eval/run.mjs --config eval/configs/v1-t2-goose.json --tasks "$T2_TASKS" --out "$T2_OUT/goose" --runs 5
  node eval/run.mjs --config eval/configs/v1-t2-opencode.json --tasks "$T2_TASKS" --out "$T2_OUT/opencode" --runs 5
  node eval/score.mjs --pairs "$T2_OUT/nexus/results.jsonl" "$T2_OUT/goose/results.jsonl" "$T2_OUT/opencode/results.jsonl"
  ```

  Record the resolved `T2_TASKS`, unique `T2_OUT`, config digests, installed RC identity, model fingerprint, and exact commands in the frozen run record before starting. A failed or interrupted invocation remains evidence; any permitted infrastructure rerun uses the accepted rerun procedure and is retained separately. Do not score until all required runs and manifests exist. The scorer accepts exactly the Nexus, Goose and OpenCode result files.

### 6.2 T4 fault injection (ACC-QUAL-T4)

8 fault classes × 5 runs on the Nexus RC, via `eval/faults/proxy.mjs` and the fixture hooks:

1. refused connection mid-turn
2. 5xx / overloaded
3. stream cut mid-tool-call
4. output-limit truncation
5. hanging test command
6. disk full
7. context overflow at 32k
8. malformed tool-call JSON
9. SIGTERM then `run --resume`

### 6.3 T3 long tasks (ACC-QUAL-T3)

- 8 tasks × 5 runs. Each run must have ≥ 60 steps, ≥ 2 compactions and scripted steering.

### 6.4 Thresholds (DEC-05; all must hold)

| Metric | Gate |
|---|---|
| False VERIFIED (T2 + T3 + T4) | **= 0** |
| T2 pooled hidden-test correctness | ≥ 60% and ≥ best matched peer − 10 pts |
| T2 per class (bugfix, feature, refactor, debug) | ≥ 40% |
| Crash rate (all Nexus runs) | ≤ 2% |
| Regression rate | ≤ 5% |
| T4 truthful outcome | = 100% |
| T4 hang beyond budget + 5 min | = 0 |
| T3 false-absence | = 0 |
| T3 steering honoured | ≥ 95% |
| Operator interventions in `run` mode | = 0 |

The scorer output `verdict.md` lists each metric with its Wilson 95% interval, along with the infrastructure reruns and the excluded contaminated runs.

## 7. Install, upgrade, rollback, uninstall (ACC-PLAT; E2)

| Case | Command | Pass condition |
|---|---|---|
| Fresh install, each image with Node ≥ 20 | Documented one-line command with `NEXUS_VERSION=<rc>`, then the no-version command after v1.0.0 is published | Installed. `nexus --version` equals the RC. `nexus doctor` shows no version warning and an empty stderr. |
| No Node / Node 12 | Same | Clear prerequisite message. HOME untouched. |
| Upgrade alpha.2 → RC | Same, with the tag | Symlink swapped. Old version retained. User state intact. |
| Rollback RC → alpha.2 | Same, with the old tag | Works. |
| Repair | Delete a file in the version dir, then reinstall | Repaired (REQ-REL-105). |
| Uninstall (documented manual) | Commands from the quickstart | Only Nexus-owned paths removed. `~/.config/nexus` and `~/.nexus` retained. |
| Checksum tamper | installer-smoke | Refused. The existing install is unchanged. |
| Attestation | `gh attestation verify <tarball> -R mikeholownych/nexus-code` | PASS |

## 8. Independent acceptance (REQ-AGT-110, ACC-CONT-10)

The reviewer is supplied by the owner (X5) and did not implement the work under review.

The reviewer receives:

- the RC package;
- this file;
- the REQUIREMENTS ledger;
- SPEC-04;
- read access to the evidence directory.

The reviewer performs:

1. An independent re-run of a sample. At minimum:
   - ACC-SAFE-01, 03, 09;
   - ACC-PROC-02;
   - ACC-TRUST-01, 02;
   - ACC-CONT-01, 03;
   - ACC-VER-01, 03;
   - ACC-PKG-01;
   - 5 random T2 tasks;
   - 2 T4 classes.
2. One live long task (≥ 60 steps, ≥ 2 compactions) on the RC through the gateway, including one kill and resume.
3. A review of the scorer verdict and of contamination handling.

**Output:** `docs/reviews/<date>-v1-rc-independent-acceptance.md` with an ACCEPT, ACCEPT WITH DEFECTS, or REJECT verdict per area. "Accept with defects" needs an owner disposition for every defect, and for a blocker area the only acceptable disposition is a fix.

## 9. Contest (separate product; not a client gate)

The submission is completed and frozen until judging ends (DEC-13). After judging, the post-contest hardening is accepted by:

| ID | Check |
|---|---|
| CON-A1 | The CI contest job builds `agent-collab-worker`. `worker.config.json` has the configured name, and the bundle contains the `/work-state` handler. |
| CON-A2 | Broker negative tests: caller-supplied env paths and URLs are ignored. A host outside `*.artifacts.cloudflare.net` is refused. |
| CON-A3 | On a clean VM, `install.sh --fresh` followed by `post-install-qualify.py` passes. |
| CON-A4 | `sudo -l` for the demo user shows only fixed argv. `sudo setpriv --reuid=0 id` is denied. |
| CON-A5 | One clean-account `--mode cloudflare --agents real` run, with a committed, redacted run record. |
| CON-A6 | The video source commits are tagged and published, or the docs state that they are unpublished. |

## 10. Release decision (G6)

The stable v1.0.0 release may be tagged only when every item below holds. RC tags are candidate construction inputs governed by §1.1; an RC tag or its successful build does not satisfy this release decision.

- [ ] G0–G4 automated gates pass on the final RC commit (§3).
- [ ] §4 standalone and provider matrix: all rows PASS.
- [ ] §5 terminal acceptance: CI, scripted and manual gates PASS.
- [ ] §6 thresholds: all hold.
- [ ] §7 install matrix: all rows PASS.
- [ ] §8 independent acceptance: ACCEPT, or ACCEPT WITH DEFECTS with owner dispositions and no blocker defects outstanding.
- [ ] `scripts/check_requirements.mjs --enforce` passes:
  - every B row is `product-qualified`, or `tested` with a recorded justification for why product qualification does not apply;
  - every RR row is ≥ `tested`.
- [ ] Docs checklist (SPEC-09 §3.2) is signed off.
- [ ] Release notes state the standalone scope (DEC-16), the provider tiers (DEC-06), the experimental surfaces (DEC-03, DEC-07) and the known limitations.
- [ ] Owner approval to publish (X7).

**Outcome recording.** The release decision record goes in `docs/releases/v1.0.0.md`, with links to every evidence directory.
