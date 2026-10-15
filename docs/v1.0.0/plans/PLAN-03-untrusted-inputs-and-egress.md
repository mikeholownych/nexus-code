# PLAN-03: Untrusted workspace inputs and the egress boundary

This plan implements [SPEC-03](../specs/SPEC-03-untrusted-inputs-and-egress.md). It is milestone **M1**.

- **Requirements:** REQ-SEC-110 through REQ-SEC-118, and REQ-PRV-108.
- **Decisions:** DEC-04 and DEC-15.

## Safe change boundary

- `cli/src/config.ts`
- `cli/src/client.ts` (env reads only)
- `cli/src/credentials.ts:243`
- `cli/src/core/provider_recovery.ts` (env reads)
- `cli/src/core/egress.ts:107-160`
- `cli/src/tools.ts:52-111,653-662`
- `cli/src/skills.ts`
- `cli/src/knowledge.ts`
- `cli/src/agent.ts` (system prompt assembly at ~3301 and ~3789, autoExtract call at 4934-4936)
- `cli/src/plugins.ts`
- `cli/src/search_web.ts`
- `cli/src/security.ts` (protected paths)
- `cli/src/doctor.ts` (report ignored keys)

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | Introduce an `EffectiveConfig` with the layers operator env, operator file, project allowlist and install defaults. Project `.env` is parsed with `dotenv.parse` and is never assigned into `process.env`. | `config.ts:16-72` | — |
| 2 | Inventory every `process.env.` read (`grep -rn "process.env" cli/src`). Route Nexus keys through `EffectiveConfig`, and leave genuine OS keys (HOME, PATH) on the operator env. | `client.ts`, `credentials.ts`, `provider_recovery.ts`, `config.ts`, `sandbox.ts`, `mcp.ts` | 1 |
| 3 | Report ignored project keys: a startup notice, plus a `config.project_env_ignored` doctor check. | `index.ts`, `sidecar.ts`, `doctor.ts` | 1 |
| 4 | CIDR-based locality: classification table, reason codes, operator-only `NEXUS_LOCAL_ORIGINS`, and the reason shown in the cloud notice. | `core/egress.ts:107-160`; notice in `client.ts:509-520` | 1 |
| 5 | `safeFetch`: DNS pin, manual redirects (max 5), public-address check per hop, streaming 5 MB cap. Used by `fetch_web`. Browser navigation stays gated by the SPEC-01 `egress` class. | `tools.ts:52-111,653-662`; dependency `undici` (already in Node) | — |
| 6 | Trust-gate workspace skill roots and workspace `knowledge.json`. `/skills` lists untrusted entries as such. `activate_skill` on an untrusted skill is refused with a hint. Injected blocks are annotated with source and trust state (partial CTX-001). | `skills.ts:31-33`; `knowledge.ts`; `agent.ts:3301,3789`; `slash/extension_commands.ts` | — |
| 7 | Knowledge: lazy constructor (no `mkdir`), no writes in read-only mode, `autoExtract` behind `NEXUS_KNOWLEDGE_AUTOEXTRACT=1` with a notice. | `knowledge.ts:34-43,206-231`; `agent.ts:4934-4936` | — |
| 8 | Plugins: remove the `~/.config/opencode/plugins` root, delete `executeSandboxed`, add the EXT-004 middleware audit with digests in the audit log and flight log. | `plugins.ts:47-54,150-200,254-300`; `persistence_protection.ts` (audit writer) | — |
| 9 | `search_web`: return `success:false` when there are no results, disclose the destination on first use, and route through the disclosure gate. | `search_web.ts:49,94,143-152` | 4 |
| 10 | Protected paths: match `.env*`, check the canonical target and case-insensitive variants, and apply the check on every read tool. Document that it is advisory for `run_command`. | `security.ts:25-32,91-108`; `tools.ts:446-469` | — |
| 11 | Docs: CLOUD_PROVIDERS (authority, locality, `NEXUS_LOCAL_ORIGINS`), USER_MANUAL §4 (trust covers skills and knowledge; plugin trust model; directories), release notes (migration of project `.env` keys). | docs | all |

## PR slices

| PR | Tasks | Contents |
|---|---|---|
| PR-3a | 1-3 | Config layering. Regression test from `evidence/prv/tls.mts`. |
| PR-3b | 4, 9 | Locality and search_web. |
| PR-3c | 5 | SSRF-safe fetch. |
| PR-3d | 6-7 | Skills and knowledge trust. |
| PR-3e | 8, 10 | Plugins, EXT-004 and protected paths. |
| PR-3f | 11 | Docs. |

## Tests

- **`project_env_allowlist.test.ts`**: one case per denied class: `NODE_TLS_REJECT_UNAUTHORIZED`, `HTTPS_PROXY`, `HOME`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_TIMEOUT_MS`, `LOCAL_LLM_FALLBACK_ENDPOINTS`. Also the TLS mock check (ACC-TRUST-01). The self-signed cert is generated at test time with `openssl` or `node:crypto` (`selfsigned` is not needed: use `generateKeyPairSync` plus a pre-made fixture cert under `cli/test/fixtures/tls/`).
- **`egress.test.ts`**: extend with the ACC-TRUST-02 table.
- **`fetch_web_ssrf.test.ts`**: local HTTP server plus a redirector (ACC-TRUST-03).
- **`workspace_trust.test.ts`**: extend for skills and knowledge (ACC-TRUST-04/05).
- **`plugins_dirs.test.ts`**: sentinel plugin (ACC-TRUST-06).
- **`ext004_audit.test.ts`** (ACC-TRUST-07).
- **`search_web.test.ts`** (ACC-TRUST-08).
- **`security.test.ts`**: protected-path cases (ACC-TRUST-09).

## Migration and rollback

Migration: the release notes list the moved keys. Doctor tells users exactly which project keys were ignored, and where to put each one.

Rollback per PR:

- PR-3a is the riskiest, because it touches many env reads. Keep a temporary `NEXUS_LEGACY_PROJECT_ENV=1` escape hatch for one RC cycle only, then remove it before v1.0.0 GA.

## Definition of done

- ACC-TRUST-01 to ACC-TRUST-09 pass.
- `grep -n "override: *true" cli/src/config.ts` returns nothing.
- Ledger rows are updated, and the DEC-04 disposition is reflected in REQUIREMENTS §2.
