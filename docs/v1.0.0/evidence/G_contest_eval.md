# Scope G — Cloudflare contest product + evaluation harness

Audit of main @ db1ca55, 2026-10-14. Read-only. The runs used `<scratchpad>/snap`. The git ancestry checks used the repo's object DB (read-only).
Bottom line:
- **Contest:** the code and its local tests are real and fail closed. But **no fresh-account Cloudflare-backed run is possible from the published tree**. The documented deploy deploys the wrong Worker, and CI checks the wrong Worker. The deadline was 2026-10-14, which is today (CRITICAL_PATH_ASSESSMENT.md:11).
- **Eval:** the harness is sound for matched T2 fixture runs. The only results come from a 6-task pilot that is self-declared as tuned. No held-out set, no T3/T4, no fault injection. It cannot qualify v1 task quality as it stands.

## 1. Coverage ledger

| Files | Method |
|---|---|
| agent-collab-worker/src/index.ts, src/work-state-contract.ts, cloudflare.config.ts, package.json, tsconfig.json, vite.config.ts | full read |
| slice root: package.json, cloudflare.config.ts, tsconfig.json, vite.config.ts, .gitignore, src/index.ts | full read |
| trusted-broker-bundle/broker/demo-transport.mjs | full read |
| trusted-broker-bundle/launcher.c, build-launcher.sh | full read |
| trusted-broker-bundle/install.sh | targeted read (lines 1-60, plus grep for the verify, manifest and prior-install steps) |
| trusted-broker-bundle/README.md | targeted read (lines 1-60) |
| trusted-broker-bundle/bin/nexus-cf-broker (static ELF) | `file` + `strings` for embedded paths. Not disassembled. Not rebuilt to compare bytes. |
| trusted-broker-bundle/trusted-object-manifest.json (39k lines) | structural parse, demo-transport entry, sha256 compared against the installer constant |
| trusted-broker-bundle/BUNDLE.sha256 | executed `sha256sum -c` |
| upstream/node-v24.21.0/{pubring.kbx, SHASUMS256.txt, .sig} (vendored) | sha256 compared with README claim; `gpgv` signature check run locally against the vendored keyring. Keyring provenance (nodejs/release-keys commit) not independently re-fetched. |
| trusted-broker-bundle/{post-install-qualify.py, verify-install.py, prepare-manifest.py, normalize-install.py, rollback.sh, test-*.py} | excluded: install-time tooling for the operator host. The decision does not depend on them because the bundle fails its own checksum before reaching them. |
| trusted-broker-bundle/broker/{credential-probe-safe, credential-lifecycle, artifact-token-response, linux-bound-exec, clean-start-check}.mjs and their tests | tests executed; source skimmed |
| agent-collab-worker/*.mjs (credential-broker, brokerage-safety-gate, probes, run-experiment-3r, canaries) | grep for token, secret and logging patterns. credential-broker.mjs:110-140 read. Historical experiment code superseded by the trusted bundle (BROKERAGE_SECURITY_SUPERSESSION). |
| slice root *.mjs (contest-vertical-slice, run-experiment, run-e2-recovery, run-shared-ref-exp2b), fork-worker/, shared-ref-worker/, revoke-known-id-recovery/, agent-collab-fixture/ | skim or grep only (historical experiments, hard-coded operator resources). classify-revoke test executed. |
| package-lock.json (slice 2322 lines, bundle 1027 lines) | `npm ci` + `npm audit` (slice only) |
| demo/lib/substrate-adapter.mjs | full read |
| demo/nexus-demo.mjs | targeted (CLI options, stages 1 and 6-8) |
| demo/lib/{real-agent-runner, restricted-code-executor, integrator}.mjs | targeted grep and read |
| demo/lib/{producer-agent, consumer-agent, display}.mjs | not read (presentation and agent prompting; covered by the tests below) |
| demo/test/*.mjs | executed (`npm test --prefix demo`) |
| docs/CLOUDFLARE_CONTEST.md, docs/CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md | full read |
| docs/cloudflare/{CONTEST_SUBSTRATE_TRUTH_MATRIX, VIDEO_ASSET}.md, CF-COLLAB-TOKEN-OUTPUT-001_REMEDIATION.md (lines 1-40) | full or targeted read |
| other docs/cloudflare/*.md and *.json (approx. 40 files) | status and disposition lines extracted by grep only. Labelled HISTORICAL. |
| docs/cloudflare/evidence/.../cloudflare-agent-collaboration-demo.mp4 | excluded: binary video. Its provenance commits were checked (CON-004). |
| eval/run.mjs, score.mjs, infra.mjs, README.md, configs/*.json | full read |
| eval/tasks/*/task.json | 2 read fully (selftest-add, t2-bugfix-csv). The other 5 were listed only. Their hidden tests were not read. |
| docs/reviews/evidence/eval_pilot_2026-10-13/RESULT.md | full read (outside the scope list, but it is the only eval result) |
| experiments/routing-b1-b2-2026-10-03 | README full read. `sha256sum -c SHA256SUMS-final` executed. Transcripts and harness not read (engx_tasks.py 1187 lines not read). |
| experiments/thermal-soak-2026-10-03 | README and CORRECTION read. `sha256sum -c` executed. raw/ and policy-replay/ not read. |
| experiments/context-validation-2026-10-04 | RESULTS.md full read. Harness and results not read. |

## 2. Architecture, data flow and trust boundaries (contest)

`demo/nexus-demo.mjs` is the controller. It runs in one of two modes: `--mode local` (bare git repo in a temp dir) or `--mode cloudflare`.

In cloudflare mode:
- `CloudflareSubstrateAdapter` (substrate-adapter.mjs:200) holds **no credentials**. It runs local git with a scrubbed environment (:242-263). It sends every remote operation as JSON over stdin to the executable named in `$NEXUS_PROTECTED_TRANSPORT` (:344-361).
- That executable is meant to be the root-owned launcher `nexus-cf-broker demo-transport` (launcher.c). The launcher:
  - requires uid 0 and `SUDO_UID==1000` (:47-58),
  - calls `clearenv()` (:67),
  - sets fixed HOME `/home/mike` (:27-31, :68),
  - runs `/opt/nexus-cloudflare-broker/runtime/node` on `/opt/.../demo-transport.mjs`.
- demo-transport.mjs is the credential holder:
  - It reads `/etc/nexus-cloudflare-broker/artifacts-git.token` and `worker.bearer`. Both must be root-owned, mode 0400, and pass an inode re-check (:164-185).
  - It does git ls-remote, fetch and push to the Artifacts HTTPS remote with an `http.extraHeader` bearer (:192-212).
  - It enforces per-role ref policy (:343-373), a force-with-lease push (:334), and a scan to block the credential being reflected into git objects (:375-391).
  - It calls the Worker with a bearer (:402-437).
- The contest Worker (agent-collab-worker/src/index.ts) uses a static shared-bearer check (:10-21). It:
  - reads `contest-demo/<run>/work-state` through the Artifacts binding,
  - validates the schema and that the producer candidate ref and commit match the live ref (:50-61),
  - returns the state with a sha256.
- The adapter re-validates the identity, commit, digest and canonical JSON (:376-393).
- Generated code is validated by `RestrictedCodeExecutor`, which runs `sudo -n setpriv --reuid=65534 ... --no-new-privs env -i` (restricted-code-executor.mjs:60-71). The integrator throws on any validation failure (integrator.mjs:71, 191, 210).

**Trust boundaries:**
- demo user → (sudo) → root broker: the credential boundary.
- broker → Cloudflare Artifacts: repo-scoped token. Ref scope is NOT native (TRUTH_MATRIX row "Ref-scoped authority" = NOT_PROVEN; it is enforced in the broker).
- broker → Worker: static bearer.
- controller → generated code as uid 65534: there is no network or filesystem namespace isolation beyond the uid.

**State:** run-scoped refs in one shared Artifacts repo. The interface has no deletion (CONTEST.md:69).

## 3. Findings

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| CON-001 | S1 (contest) | Judge deploy / CI | docs/CLOUDFLARE_CONTEST.md:48-49; .github/workflows/ci.yml:29-39; experiments/cloudflare-artifacts-vertical-slice/package.json:5-9, cloudflare.config.ts:6-12, src/index.ts:3-4,66-95 | RUNTIME + SOURCE. The documented `npm run typecheck/deploy --prefix experiments/cloudflare-artifacts-vertical-slice` targets the **Experiment-1 Worker** `artifacts-first-repo`. That Worker has hard-coded namespace `nexus-exp1-oct02`, an **unauthenticated POST /create**, and an unauthenticated GET /readback that returns content. The built `worker.config.json` has name=artifacts-first-repo and namespace=nexus-exp1-oct02; the bundle has 0 occurrences of "work-state". The NEXUS_CF_* variables set in CI are inert. The contest Worker (agent-collab-worker/) has no npm scripts, no lockfile, and is never typechecked, built or deployed by any documented command. | A judge following the guide deploys the wrong service: unauthenticated, bound to the operator's namespace name, and lacking `/work-state`. The CI "contest contract" job is green without covering the submitted Worker. | Before submission: add build/typecheck/deploy scripts and a lockfile to agent-collab-worker (or point the root config at it); fix CONTEST.md; make CI build the contest Worker. |
| CON-002 | S1 (contest) | Clean-host reproduction | trusted-broker-bundle/launcher.c:27-31,47-50,67-75; broker/demo-transport.mjs:10-21,32-39,43-45 | SOURCE. **This confirms the operator note.** The launcher runs `clearenv()` and sets only HOME, XDG, LANG, PATH and NO_COLOR, so the `NEXUS_CF_*` variables forwarded by the adapter (substrate-adapter.mjs:351) never reach demo-transport. demo-transport then falls back to the hard-coded `DEMO_REPOSITORY` (operator namespace, repo id `4v94nnw1eqf0sanw`, account-specific remote) and to `DEMO_WORKER_ENDPOINT` (`*.holownych.workers.dev`). With the judge's own resources, the adapter's identity check (substrate-adapter.mjs:225) will throw `PROTECTED_REPOSITORY_IDENTITY_MISMATCH`. The launcher is also bound to SUDO_UID=1000 and HOME=/home/mike. | No judge or other host can complete `--mode cloudflare`. The resource parameterization added in 7569c28 is dead code on the protected path. | Configuration must come from a root-owned config file read by the broker (see CON-003 for why env passthrough is unsafe). Make the uid and HOME build parameters. Rebuild and re-hash. |
| CON-003 | S2 (latent security hazard in the obvious fix) | Credential scoping | demo-transport.mjs:42-45,56-57,164-185,205,410 | SOURCE + INFERENCE. If CON-002 is "fixed" by passing env through the launcher, the caller (uid 1000 via sudo) would control: `NEXUS_CF_ARTIFACTS_REMOTE` (any https URL); `NEXUS_CF_WORKER_ENDPOINT` (any https URL); and `NEXUS_CF_ARTIFACT_CREDENTIAL_PATH` / `WORKER_BEARER_PATH`. The path check (:168-171) accepts **any** root-owned 0400, nlink=1, 16-4096-byte printable file and does not check the directory. That file would be sent as `Authorization: Bearer` to the caller-chosen URL, which exfiltrates root-only secrets. Today `clearenv()` blocks this path, which makes this latent rather than exploitable. | A privilege-boundary bypass if the env-passthrough remediation is chosen. | Remediation for CON-002 must pin the remote host (`*.artifacts.cloudflare.net`), the Worker origin and the credential paths in root-owned configuration. Add a negative test. |
| CON-004 | S2 (contest) | Provenance of submitted evidence | docs/cloudflare/VIDEO_ASSET.md:17-19; docs/CLOUDFLARE_CONTEST.md:5 | SOURCE (git). The video's recorded source commits are `731f5d44…` (Nexus) and `98a8a813…` (contest-demo). Neither is an ancestor of main. They exist only on local branches (`dogfood/*`, `candidate/*`, `contest-demo`) and are on no remote-tracking branch. The run record and freeze manifest the doc cites are not committed. VIDEO_ASSET itself records a CLI bundle hash delta and says "No clean Cloudflare-backed replay has been made from the target tree". | Judges cannot tie the video to published source. The video is HISTORICAL evidence of an operator-host run only. | Publish the run record and freeze manifest, plus a tag or branch containing 98a8a813. Alternatively, state plainly that the source behind the video is unpublished. |
| CON-005 | S2 (contest) | Broker install | trusted-broker-bundle/BUNDLE.sha256:11; trusted-object-manifest.json:113-121; install.sh:52-60,92 | RUNTIME: `sha256sum -c BUNDLE.sha256` gives `./broker/demo-transport.mjs: FAILED` (actual 0ad7c7da…, recorded 3238d2e9…). install.sh:92 runs `sha256sum --check` under `set -e`, so **the committed bundle cannot be installed**; it fails closed. The installer also *requires* a prior install at /opt/nexus-cloudflare-broker with a pinned prior manifest (:5-7,52-60). There is no fresh-install path. | The parameterized transport has never been reviewed or hashed into the trust root. The "upgrade-only" installer cannot bootstrap a clean host. | Re-hash after review. Add a fresh-install mode. |
| CON-006 | S2 (contest) | Judge setup | substrate-adapter.mjs:345; CONTEST.md:31,54-60 | SOURCE. `NEXUS_PROTECTED_TRANSPORT` is required but appears nowhere in the docs. The launcher requires root with `SUDO_UID=1000`, yet the adapter spawns the executable directly; the sudo wrapper and sudoers rule are not in the repo. CONTEST.md:31 asks judges to allow passwordless sudo for `setpriv`. Unrestricted `sudo setpriv` is equivalent to root (`setpriv --reuid=0 …`). | Undocumented required setup. The guidance as written grants the demo user effective root. | Ship a sudoers drop-in with exact argument vectors (or a setuid-free design) and document the transport variable. |
| CON-007 | S3 | Generated-code containment | restricted-code-executor.mjs:52-71 | SOURCE. The isolation is uid 65534, `--no-new-privs`, cleared groups and a scrubbed env. It has no network namespace, seccomp or mount isolation, so model-generated TypeScript/tests can reach the network and read world-readable host files. The tests (RUNTIME) confirm uid, caps=0, env keys and no docker or lxd socket access. | A bounded risk on a single-user demo host. The docs already say not to use shared hosts (CONTEST.md:31). | Accept for the contest. For any non-demo use: `unshare -n` / bubblewrap. |
| CON-008 | S3 | Credential lifecycle | demo-transport.mjs:20-21,270; TRUTH_MATRIX "Read-only/write credential scope" | SOURCE + DOC-CLAIM. The transport uses a **long-lived, repo-wide** write token from a file, not the "scoped short-lived credentials" in the MDP (CRITICAL_PATH_ASSESSMENT.md:164). Ref scoping is enforced only by the broker. Rotation and revocation of the file token are not automated. The token reaches git as `GIT_CONFIG_VALUE_0` in the child env (:205), which is readable only by root because the broker runs as root. | The blast radius of the token is the whole repo, not one run. | Document the token TTL and rotation. Prefer per-run tokens (the lifecycle code exists in credential-lifecycle.mjs). |
| CON-009 | S3 | Supply chain (dev) | slice package.json:12-13; package-lock.json | RUNTIME: `npm audit` reports 5 high (sharp → miniflare → @cloudflare/runtime-types → @cloudflare/vite-plugin, cf ≤1.0.0-beta.13). Root package.json uses the floating `"beta"` tag for @cloudflare/vite-plugin (the lock pins it). | Build-time only; not shipped to the Worker runtime. | Bump cf / vite-plugin when compatible. |
| CON-010 | S3 | Typecheck gap | agent-collab-worker/cloudflare.config.ts:5; tsconfig.json:7 | RUNTIME. tsc on agent-collab-worker reports `TS2591 Cannot find name 'process'` (`types: []`). The Worker *builds* when invoked from its directory using the parent node_modules (worker.config.json name=nexus-contest-ci, bindings correct). | Once CON-001 is fixed, CI would fail until this is fixed too. | Add `@types/node` or a typed `process` declaration for the config file. |
| CON-011 | S3 | Worker auth | agent-collab-worker/src/index.ts:10-21 | SOURCE. The single static shared bearer (`EXPERIMENT_AUTH`) is used for every run, with no expiry. The compare is constant-time except for the length check. `/health` is unauthenticated and minimal (OK). The Artifacts binding covers the whole namespace; the Worker reads only the configured repo. | Acceptable for a bounded demo, not for a multi-tenant service. The contest doc already disclaims production security (CONTEST.md:15). | Per-run or HMAC tokens after the contest. |
| CON-012 | S4 | Doc staleness | docs/CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md:11,34,88-90 | DOC-CLAIM. The doc dated 2026-10-02 says "Nexus currently has no Cloudflare Worker". This is now false and the doc is not marked superseded. CONTEST.md:65 and :89 *correctly* say "blocked pending clean-account acceptance". | Reviewer confusion. | Mark the doc HISTORICAL. |
| CON-013 | S4 | Info exposure | demo-transport.mjs:10-19; contest-vertical-slice.mjs:8-10; credential-broker.mjs:110,125 | SOURCE. The Cloudflare account ID (in the remote hostname), the workers.dev subdomain and `/home/mike/...` paths are committed. These are not secrets. | Low. | Optional scrub. |
| CON-014 | S4 | Demo display | nexus-demo.mjs:124,351-352 | SOURCE. "npm test -> PASS", "TypeScript 5.9.3 … 0 errors" and "First-Pass Pass YES" are static strings. They are reached only after a validation that would otherwise throw, so they are not false, but they are not computed. | Cosmetic. | Print the computed values. |
| EVL-001 | S1 (v1 task-quality claim) | Qualification evidence | eval/README.md:42,47-58; docs/reviews/evidence/eval_pilot_2026-10-13/RESULT.md:62-63 | DOC-CLAIM + SOURCE. The only scored evidence is 6 in-repo T2 fixture tasks. RESULT.md itself says "These six tasks were used to find and fix the issues … it does not qualify Nexus. Qualification needs a fresh task set." Missing: held-out tasks, the T3 long-task set, the T4 fault injector, the T3 fact-sheet scorer, and runs on the release candidate. The measured builds are 76f4081, ed17e99 and 4fcbe68-dirty; their rebased equivalents (fe576f1, d116e99, 0090f9c) are on main, but db1ca55 itself was never evaluated. | No basis for a v1 claim about task quality. The pilot verdict was "NOT QUALIFIED (false VERIFIED=2)". The rerun had 0 false VERIFIED, but on tuned tasks. | A v1 protocol is in §7. |
| EVL-002 | S2 | Scoring bias | eval/infra.mjs:31; score.mjs:16-21 | SOURCE. The infrastructure-rerun rule is asymmetric. For Nexus, **any run with no parsed `turn`** (a crash, a JSON parse failure or a timeout kill) is classified as infrastructure, whether or not it passed, and gets rerun. For peers, a run is rerun only on a connection-error signature AND `!hiddenPass`. `score.mjs` lets any later record replace an earlier one by (config, task, run), so `--pairs` can replace any run. | Nexus crashes become reruns instead of failures. That biases the pooled rate in Nexus's favour and hides crash rate (a v1 robustness metric). | Count a run as infrastructure only on an evidence signature (gateway unreachable before the first model call), symmetrically. Report the crash rate separately. Have the scorer log which runs were replaced and why. |
| EVL-003 | S3 | Contamination control | eval/run.mjs:57-59,178; score.mjs:80-84 | SOURCE. Agents run as the operator's user with the task dir (including hidden tests) readable. Detection catches only (a) a changed task dir or (b) the task path appearing in agent stdout or stderr. Peers rarely echo tool output. Contaminated runs are counted but **still included** in the pooled pass rate. | Hidden-test leakage might go undetected and would be scored. | Stage hidden tests outside the readable tree (another uid, or copy in after the run from a root-only dir). Exclude contaminated runs from the pooled rate. |
| EVL-004 | S3 | Matched-condition identity | eval/run.mjs:31,50,114,118; configs/pilot-*.json | SOURCE. The manifest records the model *alias* (`engineering/lead`) but not the weights digest, server build or sampling parameters. No temperature or seed is set for Nexus or peers (each uses its own defaults). The full operator `process.env` is inherited (:114), so ambient env can differ per agent. Concurrent agents share one gateway, which the pilot notes inflated wall times. | "Same model, same budget" is asserted, not recorded. Speed comparisons are confounded. | Record a gateway model fingerprint (GGUF sha, llama.cpp build, sampling) per run. Use a minimal allow-listed env. Run serially, or report queueing. |
| EVL-005 | S3 | Metric coverage | eval/score.mjs:48-69 | SOURCE. Missing metrics: recovery (after an injected fault), intervention (operator prompts or approvals), an explicit bounded-failure classification, and cost per correct task. Regressions are counted only when the repo's own suite fails. | Missing v1 dimensions. | See §7. |
| EVL-006 | S4 | Doc staleness | eval/README.md:52-57 vs :60-71 and run.mjs:120-143 | SOURCE. The status table says peer adapters and the T2 task set are "not started". Aider, OpenCode and Goose adapters and 6 T2 tasks exist. | Misleading status. | Update. |
| EVL-007 | S4 | Repo hygiene | experiments/context-validation-2026-10-04/harness/__pycache__/*.pyc (3 tracked) | SOURCE. Tracked bytecode files. | Noise. | Remove and ignore. |

## 4. Reproductions

```sh
# snap = <scratchpad>/snap (non-git export of db1ca55)
npm ci --prefix demo && npm ci --prefix experiments/cloudflare-artifacts-vertical-slice
NEXUS_CF_WORKER_NAME=nexus-contest-ci NEXUS_CF_NAMESPACE=nexus-contest-ci NEXUS_CF_REPOSITORY=fixture \
  npm run typecheck --prefix experiments/cloudflare-artifacts-vertical-slice   # -> rc 0
... npm run build --prefix experiments/cloudflare-artifacts-vertical-slice    # -> built 4.95 kB
cat experiments/cloudflare-artifacts-vertical-slice/.cloudflare/output/v0/workers/default/worker.config.json
# {"name":"artifacts-first-repo",...,"env":{"ARTIFACTS":{"type":"artifacts","namespace":"nexus-exp1-oct02",...}}}   <- CON-001
grep -c work-state .../bundle/index.js   # 0 ; grep -c external-git-proof -> 1

# contest Worker, built manually from its own dir (CON-010)
cd agent-collab-worker && ../node_modules/.bin/cf workers types && ../node_modules/.bin/tsc -p .
# cloudflare.config.ts(5,16): error TS2591: Cannot find name 'process'.
../node_modules/.bin/cf build   # ok; worker.config.json name=nexus-contest-ci, NEXUS_NAMESPACE/REPOSITORY text, EXPERIMENT_AUTH secret

# CON-005
cd /home/mike/nexus-code/experiments/cloudflare-artifacts-vertical-slice/trusted-broker-bundle && sha256sum -c BUNDLE.sha256 | grep -v ': OK'
# ./broker/demo-transport.mjs: FAILED   (actual 0ad7c7da…, recorded 3238d2e9… also in trusted-object-manifest.json:117)

# CON-004
git merge-base --is-ancestor 98a8a813430cbd0dc9b54ee97a594f0bc7087cd6 HEAD  -> not ancestor; branch -a --contains -> only local 'contest-demo'; branch -r --contains -> none
git merge-base --is-ancestor 731f5d44c7b548938d1f011bd88269b09df2bff4 HEAD  -> not ancestor; remote branches: none
```

## 5. Strengths, with evidence

- **Credential custody in the broker is careful.** Checks on owner, 0400 mode, nlink and inode-before/after; O_NOFOLLOW; buffers zero-filled after use; a reflection scan over all git objects; error output limited to an allowlist of codes (demo-transport.mjs:152-185,375-391). Executables are bound by file descriptor (linux-bound-exec). Git config is hardened (no system or global config, no hooks, no credential helper, `followRedirects=false`, protocol allowlist) at :192-212. Tests are RUNTIME-verified: demo-transport 8/8; artifact-token-response 14 revoke cases plus 8 post-revoke cases; credential-lifecycle 25 assertions; linux-bound-exec; classify-revoke 11 cases; worker token-response 10/10; work-state-contract 2/2.
- **`clearenv()` in the launcher** currently prevents the caller-controlled exfiltration in CON-003.
- **The adapter and Worker re-validate in two places:** identity, commit, sha256 digest of canonical JSON, and producer-ref liveness (409 if the candidate moved) (index.ts:56-61; substrate-adapter.mjs:376-393).
- **The ref policy enforces a lot:** baseline and work-state refs are write-once; candidates must descend from the baseline and fast-forward; work-state is a parentless single-file commit pointing at the live producer SHA; integration must contain both candidates (demo-transport.mjs:343-373).
- **The vendored Node trust root checks out (RUNTIME):** the pubring sha256 matches the README; `gpgv` gives "Good signature" from 5BE8A3F6…; the SHASUMS line for linux-x64 matches install.sh:11; the manifest sha matches install.sh:13. The installer fails closed on a checksum mismatch.
- **The docs are honest about the block:** CONTEST.md:15,65,89 and VIDEO_ASSET.md:19 do not claim reproducibility. Offline modes are labelled. In real-agent mode the demo labels the control/treatment contrast as historical (nexus-demo.mjs:313-314).
- **Eval harness design is solid:**
  - fresh workspace and HOME per run; budgets enforced with process-group kill; hidden tests copied in only after the agent stops;
  - scores kept separate, with Wilson CIs;
  - false VERIFIED tracked;
  - the T1 self-test is wired into `make test` (cli/test/eval_harness.test.ts:45-73);
  - thresholds were pre-registered before scoring, the pilot was honestly self-graded NOT QUALIFIED, and its tasks were declared tuned.
- **Experiment archives are preserved with checksums.** RUNTIME: `sha256sum -c` passes for routing evidence/SHA256SUMS-final and thermal-soak/SHA256SUMS. The routing README states "nothing here was tuned or re-run after the results were known".

## 6. Qualification gaps and how to close each one

- **G1: the contest Worker has never been deployed from this tree** (a HISTORICAL deployment exists: `nexus-agent-collab-exp1-20261002`). To qualify:
  1. Fix CON-001 and CON-002.
  2. On a fresh Ubuntu 24.04 VM with a fresh Cloudflare account: create the namespace and repo, deploy agent-collab-worker, install the broker from scratch, and provision the two 0400 files.
  3. Run `npm run demo:cloudflare --prefix demo -- --agents real --fast`.
  4. Confirm the refs and SHAs in Artifacts match the printed values, and that the Worker's `stateContentSha256` matches.
  5. Commit a redacted run record.
- **G2: Worker behaviour under real Artifacts semantics** (log or readFile on a missing ref, size limits) is tested only through stubs. To qualify, use `cf dev` with remote bindings against a disposable namespace and run the negative cases: unknown run, moved candidate (409), state >16 KiB (413), bad schema (502).
- **G3: generated-code containment** (network and file reads). To qualify, add tests in which generated code attempts `fetch('http://example.com')` and reads `/home/*/.config`. Expected: blocked once netns is added.
- **G4: eval results on db1ca55.** To qualify, rerun the T2 pilot on db1ca55 with a clean tree (manifest `dirty=false`).
- **G5: whether the 64 KB `--json` truncation is fixed** (context-validation RESULTS §5(a)). `exitAfterFlush` exists at cli/src/index.ts:51 (SOURCE), which suggests it is. To qualify, pipe a run with more than 64 KB of JSON through `run.mjs` and assert the record parses. This matters because EVL-002 treats an unparsed turn as an infrastructure failure.
- **G6: task difficulty and discrimination.** 4 of 6 pilot tasks were 10/10 for Nexus (ceiling). To qualify, calibrate a held-out set so that no task is solved by every agent 5/5.

## 7. Proposed v1.0.0 requirements

All thresholds are proposals and need owner sign-off.

**Contest:** the contest is a separate product and is not a Nexus Code v1 client blocker. Labels below are relative to *contest submission*.

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| CON-R1 | The documented deploy and CI build/typecheck target agent-collab-worker, with a lockfile and scripts | workflow | BLOCKER (contest) | CI artifact `worker.config.json` has the configured name and contains a `/work-state` handler. The root Exp-1 Worker is moved to historical or deleted. |
| CON-R2 | The broker reads its resource config from a root-owned file. Remote host is pinned to `*.artifacts.cloudflare.net`, Worker origin and credential paths are pinned. No caller env influences them. | safety | BLOCKER (contest) | A negative test where caller-supplied paths or URLs are ignored. A fresh-resource run passes the identity check. |
| CON-R3 | Fresh-install path for the broker (no prior-manifest requirement); uid and HOME as build parameters; BUNDLE.sha256 and manifest regenerated after review | workflow | BLOCKER (contest) | `install.sh --fresh` on a clean VM, followed by `post-install-qualify.py`, passes. |
| CON-R4 | One independent clean-account Cloudflare-backed end-to-end run, with a committed redacted run record | failure / evidence | BLOCKER (contest claim of reproducibility). Otherwise submit with an explicit "operator-host only" statement. | G1 procedure |
| CON-R5 | The video's source commits and run record are published (tag) | evidence | RELEASE-REQUIRED (contest) | `git branch -r --contains 98a8a813` is non-empty |
| CON-R6 | sudoers drop-in with exact argv; no blanket `setpriv` | safety | RELEASE-REQUIRED (contest) | `sudo -l` shows only the fixed argv. `sudo setpriv --reuid=0 id` is denied. |
| CON-R7 | Network isolation for generated-code validation | safety | POST-V1 | G3 tests |

**Evaluation protocol for v1 task-quality qualification:**

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| EVL-R1 | **Held-out set:** at least 40 T2 tasks (proposal). At least 50% from external repos at pinned commits (JS/TS, Python, Rust, Go). The held-out half is authored by someone other than the Nexus developer and kept outside the repo (encrypted or private) until the freeze. The 6 pilot tasks plus the routing engx T01-T12 count as a *development* set only. | workflow | BLOCKER for any v1 quality claim | The manifest lists task sha256s committed *before* the release-candidate (RC) freeze. Tasks are revealed after scoring. |
| EVL-R2 | **Matched conditions:** fixed RC commit (clean); a model fingerprint (weights sha, server build, sampling: temperature 0 or a fixed seed where supported); identical step and minute budgets; minimal allow-listed env; serial execution or recorded queueing | compat / matching | BLOCKER | `manifest.json` has every field. A run is invalid if any field is missing. |
| EVL-R3 | At least 5 runs per task and configuration. Peer baseline: at least one matched peer (proposal: OpenCode and Goose). Cloud configuration optional. | stats | BLOCKER | `score.mjs` n≥5 per row |
| EVL-R4 | **Metrics, reported separately:** hidden-test correctness; completion claimed; false VERIFIED; regressions (repo suite plus a pre/post diff of previously passing tests); crash rate; timeout rate; bounded-failure truthfulness (outcome ∈ {BLOCKED, BUDGET_EXHAUSTED, UNVERIFIED} with a correct reason when hidden tests fail); intervention count (operator inputs required, which must be 0 in `run` mode); cost (tokens and wall time per correct task) | workflow | BLOCKER | The scorer emits each metric. |
| EVL-R5 | **T4 fault injection**, at least 8 cases × 5 runs (proposal): gateway refuses connections mid-turn; gateway 5xx/overloaded; stream cut mid-tool-call; reply truncated at the output limit; tool timeout (a hanging test command); disk full in the workspace; context-window overflow (32k limit on a large repo); malformed tool-call JSON from the model; SIGTERM mid-turn followed by resume. | failure / recovery | BLOCKER | Per case: either recovery (task completes, scored as recovery rate) or a truthful bounded outcome. **Threshold proposal: 100% truthful, 0 false VERIFIED, 0 hangs past budget+5 min.** |
| EVL-R6 | **T3 long tasks:** at least 8 tasks × 5 runs, over 60 steps each, with a fact sheet and steering constraints | workflow | RELEASE-REQUIRED | README thresholds: false-absence = 0, steering ≥95% |
| EVL-R7 | Infrastructure reruns are symmetric and evidence-based (EVL-002). Contaminated runs are excluded from pooled rates (EVL-003). Hidden tests are not readable by the agent uid. | integrity | BLOCKER | Unit tests on `infra.mjs` and `score.mjs`. Contamination test: an agent that `cat`s hidden tests is flagged. |
| EVL-R8 | **Pass thresholds (proposal, owner input needed):** false VERIFIED = 0 (hard). Held-out T2 pooled correctness ≥ best matched peer − 10 points, and ≥60% absolute (proposal). No task class (bugfix, feature, refactor, debug) below 40%. Crash rate ≤2%. T4 truthful = 100%. Regression rate ≤5%. | release gate | BLOCKER | Scorer verdict table, signed off before the RC run. |
| EVL-R9 | The T1 self-test stays in CI, and a T4 smoke (scripted model, 2 fault cases) is added to CI | regression | RELEASE-REQUIRED | `make test` includes both |

## 8. Commands run

- `git ls-files … | xargs wc -l`, then `git show --stat 7569c28`, `git log` on the slice configs, `git merge-base --is-ancestor` and `git branch -a/-r --contains` for 731f5d44, 98a8a813, 76f4081, 44786a4, ed17e99, 4fcbe68 and ede562e, and `git log --grep` to find the rebased equivalents. All run in /home/mike/nexus-code; read-only.
- In snap: `npm ci --prefix demo`, `npm ci --prefix experiments/cloudflare-artifacts-vertical-slice`, `npm audit --prefix …slice`, and `npm test --prefix demo`. All demo tests passed: adapter PASS, restricted-executor PASS (uid 65534, caps 0), runner 1/1, smoke 8 stages.
- In snap: typecheck and build of the slice root with the CI env, then `cf workers types`, `tsc -p .` and `cf build` in agent-collab-worker.
- In snap: `node` on demo-transport-test, artifact-token-response-test, credential-lifecycle-test, linux-bound-exec-test, artifacts-token-response.test, classify-revoke-result-test, and work-state-contract.test (`--experimental-strip-types`). All passed.
- `sha256sum -c` on trusted-broker-bundle/BUNDLE.sha256 (1 FAILED), routing evidence/SHA256SUMS-final (OK) and thermal SHA256SUMS (OK).
- `sha256sum` on pubring.kbx and the manifest; `gpgv --keyring ./pubring.kbx SHASUMS256.txt.sig SHASUMS256.txt` gave a good signature.
- `strings` and `file` on bin/nexus-cf-broker.
- No deploys, no Cloudflare API calls, no wrangler or `cf` commands against accounts (`cf build` and `cf workers types` are local).
