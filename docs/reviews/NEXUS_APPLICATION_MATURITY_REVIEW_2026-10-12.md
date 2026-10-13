# Nexus application maturity review

**Review date:** 2026-10-12  
**Scope:** Read-only assessment of the current checkout, focused on remaining gaps to dependable application maturity. This is a prioritized review, not a claim of production certification.  
**Method:** Inspected README and architecture material, existing maturity/provider/acceptance review artifacts, and current source for security gates, SBOM generation, durable state, and export. No code or configuration was changed and no tests were run as part of this review.

## Executive assessment

Nexus has substantial engineering foundations: typed turn outcomes, durable task and verification state, provider recovery, credential-origin controls, a purpose-built security gate, and extensive test/evidence reporting in recent reviews. The remaining maturity work is less about adding another headline feature and more about proving the complete shipped product is safe, supportable, reproducible, and operable across real upgrades and failures.

**Overall verdict: strong feature and internal-control maturity; operational/product maturity remains unproven.** Highest priorities are (1) define and enforce a deliberate trust/egress policy, (2) validate packaging and release artifacts from clean builds, (3) strengthen migration/compatibility and recovery testing, and (4) establish measurable reliability/telemetry and support practices. These are gaps or evidence gaps, not assertions that every mechanism is absent.

## Evidence-backed findings

### P0 — Explicitly authorize model destinations and data egress

A prior current-source provider assessment documents that workspace `.env` can select a public endpoint and repository content will be sent there, while disclosure authorization is not enforced. It also records no provider-reported cost accounting/spending limit and no effective-provider receipt. The same assessment intentionally prevents embeddings from going to cloud providers, indicating this boundary is already recognized but incomplete. See `docs/reviews/NEXUS_CLOUD_PROVIDERS_ASSESSMENT_2026-10-11.md`, sections 3–4.

**Maturity gap:** Configuration selection and authorization are not the same thing. Make destination trust explicit, visible before first transmission, policy-controlled per workspace/task, and auditable. Include bulk context and auxiliary requests (embeddings, compaction, delegated agents), and cost ceilings for billable destinations. Treat the provider assessment as a dated snapshot and revalidate source before implementation.

**Acceptance evidence:** negative tests proving untrusted workspace configuration cannot silently redirect context; positive tests for explicit operator approval; end-to-end audit/receipt naming destination/provider/model and data class; enforceable spend/request limits.

### P1 — Release and supply-chain evidence must describe the shipped artifact

`scripts/generate_sbom.sh` constructs dependency inventory from direct `cli/package.json` dependencies and parses direct Rust dependencies from `Cargo.toml` (lines 32–94). It does not derive a complete transitive inventory from lockfiles in this implementation. Its own header calls the output CycloneDX-compatible, but compatibility claims need validation against a schema/tool. `README.md` presents broad product capability claims, while `docs/ARCHITECTURE.md` contains specific architecture assertions (e.g. permanent audit log) that need to be checked against current runtime behavior rather than treated as proof.

**Maturity gap:** Reproducible release builds, artifact provenance/signing, SBOM completeness/schema validation, installation/upgrade/uninstall tests, and a supported platform matrix are not established by the inspected evidence. Avoid overstating package contents or security properties.

**Acceptance evidence:** clean-room build from a tagged source revision; deterministic or explained build metadata; generated SBOM validated by an independent CycloneDX validator and compared with resolved lockfiles; signed checksums/provenance; install/upgrade/rollback tests on each supported platform; documentation traced to shipped behavior.

### P1 — Durable state format evolution and compatibility contract

`cli/src/core/state.ts` declares `CURRENT_STATE_SCHEMA_VERSION = 1` (line 27) and durable task records include complex objective, operation, provider recovery, and compaction provenance structures. Existing acceptance remediation explicitly treats legacy records and absent obligation fields specially (`docs/reviews/NEXUS_ACCEPTANCE_BLOCKER_REMEDIATION_2026-10-08.md`, section 2), demonstrating that compatibility is a real correctness/security boundary.

**Maturity gap:** The inspected code and reviews do not establish a complete documented migration/rollback policy for every persistent format, nor a systematic version-skew matrix across CLI/core binaries. Recovery correctness can regress silently if old, partial, or corrupted records are interpreted optimistically.

**Acceptance evidence:** versioned migration functions with fixtures from released versions; fuzz/property tests for malformed/truncated state; atomic-write and crash-injection tests at each persistence boundary; forward/backward compatibility policy and tested CLI/core mismatch behavior; fail-closed recovery with operator-visible repair/export path.

### P1 — Security posture needs adversarial boundary verification beyond scanner gates

`scripts/security_gates.sh` properly distinguishes scanner execution failure from vulnerability findings and refuses bypass variables (lines 14–23, 40–69). This is valuable, but dependency scanning does not itself validate runtime isolation, prompt injection handling, egress authorization, plugin/MCP trust, shell execution, or filesystem race boundaries. `docs/ARCHITECTURE.md` describes path jail and destructive-command protection, while the acceptance remediation documents careful symlink/descriptor checks for doctor repairs; the confidence should be based on adversarial tests for each execution surface.

**Maturity gap:** Build a threat model and test coverage map for untrusted repository content, model output, plugins/MCP servers, terminal inputs, provider responses, and concurrent filesystem changes. Ensure documentation does not imply stronger guarantees than the actual boundary provides.

**Acceptance evidence:** reviewed threat model; red-team fixtures and regression suite; dependency/scanner outage tests; least-privilege process model; explicit approval policy for irreversible/external actions; security review of plugin/MCP lifecycle and subprocess environment; reproducible vulnerability response process.

### P2 — Reliability SLOs, diagnostics, and supportability

The maturity fixes report extensive targeted tests and pseudo-terminal evidence, and the doctor work provides bounded diagnostics and repairs. These are strong feature-specific signals. They do not provide product-level reliability measures (crash-free sessions, recovery success, provider error rates, latency, cost, or safe cancellation) across representative installations.

**Maturity gap:** Add opt-in, privacy-preserving operational diagnostics and a support bundle that can be inspected locally and redacted. Define reliability targets and measure them without collecting source code or secrets. Provide actionable diagnosis for damaged state, missing native binaries, provider outage, and failed upgrades.

**Acceptance evidence:** scenario-based fault-injection suite (process kill during each durable boundary, disk full, permission changes, provider disconnect/429/partial stream, terminal resize/cancel); metrics with clear privacy controls; documented support bundle schema; recovery success and data-loss measurements.

### P2 — Product lifecycle: installation, upgrades, configuration, and recovery UX

README quick-start documents `harness`/`nexus`, while recent review evidence had to verify the actual `harness.sh` route for `nexus doctor` and separately qualify real packaging. That is evidence that source-level command tests and the user-installed executable can diverge.

**Maturity gap:** Prove the canonical installation path end to end, including fresh install, PATH resolution, native Rust binary selection, configuration precedence, upgrade with existing sessions/state, downgrade/rollback, and uninstall. Document supported environments and configuration precedence in one authoritative place.

**Acceptance evidence:** install tests against produced archives/packages rather than the source checkout; clean HOME and upgrade fixtures; CLI smoke tests from every documented entry point; explicit compatibility and rollback instructions.

### P2 — Performance and cost governance for long-running tasks

The provider assessment records token usage as estimated in some paths and no cost/spending controls. Session export explains that prompt totals sum input tokens for every request and repeated context retransmission drives cumulative usage (`cli/src/session_export.ts:86–88`). This makes accounting clarity and resource bounds important even where continuation/stagnation budgets exist.

**Maturity gap:** Separate provider-reported usage from estimates everywhere, define budgets for wall time, requests, context, tokens, and money where applicable, and expose early warnings and hard-stop behavior. Measure compaction effectiveness and repeated-context overhead rather than inferring savings.

**Acceptance evidence:** deterministic accounting tests for retries/streams/provider usage; cost-limit tests including missing/unknown price data; benchmarks on representative repositories; reports that distinguish cumulative input from unique context and estimates from provider totals.

## Recommended sequencing

1. Reconfirm the egress/destination trust boundary against current implementation; close silent disclosure and cost-control risks before broad cloud use.
2. Establish the release pipeline as the source of truth: clean builds, package-level install tests, SBOM validation/completeness, provenance, supported platform matrix.
3. Create persistent-state compatibility fixtures and crash/fault injection; specify migration and recovery guarantees.
4. Conduct a threat-model-led adversarial review across shell, tools, plugins/MCP, filesystem, provider, and terminal boundaries.
5. Define operational SLOs, privacy-preserving diagnostics, support bundles, and measured resource/cost reporting.
6. Reconcile README and architecture claims against shipped binaries and supported workflows.

## Limitations and confidence

This review is based on inspected repository files and dated assessment artifacts, not a fresh full test/build run, independent penetration test, or package installation exercise. The checkout status was previously observed clean during this session. Several observations are explicitly evidence gaps: absence of proof in the inspected materials is not proof that no implementation exists. The cloud/provider assessment is dated 2026-10-11 and must be revalidated against current source before treating its particulars as current facts. No defects were reproduced during this read-only review.
