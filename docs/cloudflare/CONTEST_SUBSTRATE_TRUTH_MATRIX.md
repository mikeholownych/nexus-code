# Cloudflare Contest Substrate Truth Matrix

**Status:** Authoritative Reconstructed Substrate Baseline
**Date:** 2026-10-02
**Governance:** Strict evidentiary qualification (PROVEN, QUALIFIED_BOUNDED, OBSERVED_UNQUALIFIED, NOT_PROVEN, NOT_TESTED, DISPROVEN). Claims inherited from advisory reviews without evidence are rejected.

## Reconstructed Capability Matrix

| Capability | Status | Evidence & Independent Qualification Basis | Contest Critical Path Disposition |
| :--- | :--- | :--- | :--- |
| **Worker → Artifact access** | `PROVEN` | Worker `nexus-agent-collab-exp1-20261002` implements `env.ARTIFACTS.get()`. Successfully reads commits, tree objects, and `.agent/work-state.json` via native Worker binding. Verified in E1 & E3 via `read-work-state.mjs`. | **Adopted as Core Substrate** |
| **External Git roundtrip** | `PROVEN` | Push/fetch roundtrip over HTTPS with Bearer token authentication verified in E1 (`external-git-proof.git`) and live validated by today's qualified real probe (`jk399y9sgwalxx0h` verifying remote HEAD `ec3affd0e916b895e3528de6747b632f428359c0`). | **Adopted as Core Substrate** |
| **Exact Git identity** | `PROVEN` | Local SHA-1 commit hashes, tree hashes, and author metadata match Cloudflare Artifacts commit logs exactly across all experiments (e.g. `0e90fdd...`, `70e9510...`, `43be8f...`). | **Adopted as Core Substrate** |
| **Read-only/write credential scope**| `QUALIFIED_BOUNDED`| Cloudflare Artifacts API tokens enforce `read` vs `write` at repository granularity (observed in E1/E3). However, tokens do not support ref/branch path restrictions. | **Adopted with Bounded Repo-Level Scope** |
| **Artifact fork creation** | `PROVEN` | Forking via `cf artifacts namespaces repos create --source artifacts:<ns>/<base>` verified. Repositories `nexus-agent-collab-e1-b`, `-control`, `-treatment` exist in `nexus-exp1-oct02` with `source` pointing to base. | **Available if Needed** |
| **Fork exact identity** | `QUALIFIED_BOUNDED`| Fork initially inherits commit tree and default branch state of source repo at creation time. Validated in E1/E2. | **Available if Needed** |
| **Fork cross-repo isolation** | `OBSERVED_UNQUALIFIED`| Independent review falsified E2 proof because ephemeral evidence was destroyed prior to audit. While standard Git remotes isolate objects, qualified Cloudflare isolation evidence was not preserved. | **DEFERRED: Contest Slice will use ref/branch candidate isolation on shared repo rather than relying on unproven fork isolation.** |
| **Shared-ref behavior** | `OBSERVED_UNQUALIFIED`| E2 planned shared-ref tests, but differential execution was blocked and never executed. | **DEFERRED: Not needed on critical path.** |
| **Ref-scoped authority** | `NOT_PROVEN` | Native Cloudflare Artifacts tokens lack ref-level permission ACLs. Any ref-level authority differential must be enforced by application layer (Nexus execution spine / Worker), not native Cloudflare tokens. | **Enforced in Nexus Layer, not Cloudflare Native** |
| **Worker work-state** | `PROVEN` | Worker successfully parses and serves `.agent/work-state.json` (`nexus.agent-work-state.v1`), validates candidate commit SHA against Git ref, and computes SHA-256 digest over live endpoint. | **Adopted as Core Substrate** |
| **Agent collaboration advantage** | `NOT_PROVEN` | E3 tested disjoint README changes where both control and treatment required 0 corrective commits (`CORRECTIVE_COMMITS = 0`), showing no collaboration advantage. Proving advantage requires a consequential breaking contract change (Priority 2). | **Must be evaluated in Priority 2 Corrected Collaboration Experiment** |

## Evidentiary Decisions for Contest Architecture

1. **Fork Isolation Deferred:** The contest vertical slice does NOT require cross-repo fork isolation. Bounded, auditable isolation is achieved via branch/ref isolation (`refs/heads/candidates/<actor-id>`) within the shared repository.
2. **Ref-Scoped Authority Bounded:** We will not make unproven claims that Cloudflare tokens restrict specific branches. The Worker and Nexus harness enforce state access rules.
3. **Collaboration Advantage Unproven:** Prior experiments did not demonstrate collaboration value. Priority 2 will test an explicit breaking interface change to measure corrective commit divergence between control and treatment.
