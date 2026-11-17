# Changelog

All notable changes to Nexus Code are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Detailed per-release documentation is maintained in [`docs/releases/`](docs/releases/).

## [Unreleased]

### Security

- Commands run through `run_command` no longer inherit credentials from the Nexus process. Variables from `~/.config/nexus/config.env`, plus anything named like a key, token, secret or password, `AWS_*`, `GH_TOKEN` and similar, are removed from the command environment, including inside the write-mode bwrap sandbox. To pass a variable through deliberately, list its name in `NEXUS_COMMAND_ENV_PASSTHROUGH` (operator environment or `config.env` only). Commands that relied on `SSH_AUTH_SOCK`, `GH_TOKEN` and similar must now opt in. Without `--sandbox` a command still runs as your user and can read your files and its parent processes' environment.
- `--sandbox` now actually confines. Write-mode sandboxed commands run with `$HOME` masked, so `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.config/nexus` are unreadable, even when the workspace is, contains, or sits above `$HOME`. Only toolchain directories (`~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.local/bin`, `~/.npm`, `~/.cache/pip`, `~/go/pkg`, `PATH` entries under HOME) are mounted read-only; extend them with `NEXUS_SANDBOX_HOME_READONLY`. The network is off by default; opt in with `--sandbox-network` or `NEXUS_SANDBOX_NETWORK=1` (not implied by `--yes`). Sandboxed commands die with the runner and cannot see host processes. `nexus doctor` lists the effective mounts and overlays. Files outside `$HOME` remain readable inside the sandbox.
- The legacy task-worktree merge refuses a worktree whose `.git` was replaced, and runs Git with hooks and fsmonitor disabled; a planted `core.fsmonitor` or hook in an agent-writable worktree no longer runs code outside it. The repository's own hooks no longer fire on that commit and merge.
- The `--sandbox docker` engine runs a digest-pinned image (alpine 3.23) as the invoking uid with all capabilities dropped, `no-new-privileges`, a read-only root plus a tmpfs `/tmp`, a 512-process limit, and no network unless `--sandbox-network` / `NEXUS_SANDBOX_NETWORK=1` is set. Only the scrubbed command environment reaches the container, and credential locations under a workspace that is or contains `$HOME` are masked. `NEXUS_SANDBOX_DOCKER_IMAGE` (operator setting) may substitute another image but it must be digest-pinned, otherwise no container is started. Commands that wrote outside the workspace and `/tmp`, relied on root, or used the network now fail in Docker mode.
- A compaction summary (including `compact --llm`) is now labelled in every request as untrusted data with its source, under the "Structured Context Memory" header: text from earlier tool output or fetched pages that reached the summary is information about the task, never instructions. The label is added to the request copy only; the stored conversation and its provenance are unchanged (plan unit CX-1).
- Per-provider spending limits (PR-10): `NEXUS_CLOUD_LIMITS` (JSON keyed by provider id with `maxRequests`, `maxTokens`, `maxCostUsd`) on top of the process-wide limits. A provider that reports no cost is priced from the models snapshot; with no price the cost limit is refused as unenforceable, and a malformed value refuses every cloud request.
- `nexus doctor` reports effective containment (CS-1): with no `--sandbox` the `sandbox.confinement` finding says "Effective containment: none", whether bubblewrap is available, and the flag that turns confinement on. Containment stays opt-in (decision D1); nothing about how commands run changes.
- Prompt-injection scanner (CS-7): a tool result that carries instruction-like text aimed at the assistant, hidden or bidirectional Unicode, fake chat or tool-call markup, or an encoded payload of those is labelled and fenced (`<<<UNTRUSTED RESULT BEGIN/END>>>`, content kept, hidden characters shown as `<U+XXXX>`), reported on the `security.injection_suspected` stream event, and gates the next step's state-changing calls on operator approval when an operator is present. A heuristic, not a guarantee: on the labelled corpus it caught 54/64 attacks it was tuned on and 15/30 written after it was frozen (0/12 deliberate evasions) and flagged 5/45 and 2/24 benign samples. See the User Manual for the limits.

### Fixed

- CERI evidence store (audit F06, MQ-7 slice B): evidence paths are checked by resolved path, not by string prefix. A symlinked evaluation or run directory that leads outside the store is refused. Run ids must start with a letter or digit, be at most 128 characters, and avoid `..` and the `.abandoned-` marker. A run id that differs from an existing one only by case is refused. See `docs/CERI_EVIDENCE.md` for what the integrity record does and does not prove.
- CERI baseline comparison (audit F02, MQ-7 slice C): a baseline is bound only when manifest hash, model name, digest and quantization, sampling, fixture identity (new `fixtureSha256`, `hashFixture`), evaluator and evaluation versions, configuration and toolchain all match. A mismatch gives a non-certifying result whose `identityBinding.mismatchedFields` names every differing field. `loadVerifiedBaseline` and `compareToVerifiedBaseline` are the certifying path. CONFIRMED_REGRESSION is no longer reachable from the `isRepeatReproduction` / `isPriorRegressionCandidate` flags (they are ignored for confirmation); it needs a verified baseline and a second verified run (`priorRunId`) that regressed the same assertion. The runner option `isRepeatReproduction` is replaced by `priorRunId`.

### Added

- Amazon Bedrock Converse protocol (`"protocol": "bedrock-converse"`, `"auth": "sigv4"` in `providers.json`): SigV4 signing on `node:crypto` with no new dependency, the AWS event-stream parser for ConverseStream, and a read-only AWS credential chain from the environment and the shared credentials and config files. Credentials are never printed or logged. Verified against AWS's published SigV4 test vectors and recorded fixtures (plan unit PR-7).
- Google Vertex AI over the Gemini protocol (`"protocol": "gemini-generate-content"`, `"auth": "gcp-adc"` in `providers.json`; no credentialEnv): a service-account key file (`GOOGLE_APPLICATION_CREDENTIALS`) is exchanged for a bearer token with an RS256 JWT signed on `node:crypto`, cached and refreshed one minute before expiry (concurrent requests share one refresh); with no key file the token comes from `gcloud auth print-access-token` (no shell, 15 s bound). The URL is `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent` (`global` uses `aiplatform.googleapis.com`), with project and location from `GOOGLE_CLOUD_PROJECT` (else the key file) and `GOOGLE_CLOUD_LOCATION`, both validated. The key, assertion and tokens never appear in errors or logs. Verified against fixtures and a local mock only; no live call (plan unit PR-8). `nexus doctor` no longer reports `sigv4` and `gcp-adc` providers as missing a credential.

### Added

- Gemini native wire protocol (`gemini-generate-content`, plan unit PR-6): `generateContent` and `streamGenerateContent` with `functionCall` parts (parallel calls included) mapped to tool calls, thought summaries kept out of the answer, and `thoughtSignature` parts replayed only to the model that produced them. Declare a provider with `"protocol": "gemini-generate-content"`, `"auth": "header"` and `"authHeader": "x-goog-api-key"` in `~/.config/nexus/providers.json`; the key travels in the header, never the URL. No built-in provider uses it yet (Gemini's OpenAI-compatible endpoint stays as shipped).
- `nexus` model listing understands Gemini's `models/<id>` catalog and offers only models that support `generateContent`.

### Changed

- The dependency deprecation check retries a transient npm registry failure (network error, timeout, truncated body, HTTP 429 or 5xx) up to 3 times, 1 s then 3 s apart, before failing closed; a 404 or 403 is a real answer and is not retried. A single registry blip had turned main red.
- Egress inspector (CS-8): before `fetch_web`, `search_web`, `browser_navigate`, `browser_type` or a `run_command` network command (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`...) runs, Nexus checks it for the workspace's own secrets (secret-named values in the root `.env` files as written, URL-encoded or base64; a set secret variable the command expands; a credential file it reads) and refuses it with `EGRESS_SECRET_BLOCKED`, naming the secret and never its value. Local and private-network destinations are not inspected. `egressInspector` in `.nexus-security.json` sets `mode` (`block` default, `record`, `off`) and `allowDestinations`. It does not see secrets a command builds at run time.
- Operators can declare boundary rules in an operation spec (`boundaries`: import deny/allow lists, protected public files, interface and schema files, import cycles). The review gate checks them on each candidate diff by deterministic line analysis and REJECTs a violation whatever the model says; an undeclared dependency and a potentially breaking or unclassifiable interface or schema change are advisories, and every verdict carries what was and was not analysed. The CERI scenario `cumulative-change-03` is now active, so no scenario is pending (VC-1, VC-4).
- `/compact --llm` now checks the model's summary against the gating requirements with a second bounded call before using it; a summary the check says dropped a requirement, or that could not be verified, is replaced by the deterministic summary and the reply says why. The pinned-ledger check remains the hard guarantee (CX-3).
- Each compaction now leaves an auditable record on its first archive line (the ids of the messages it covered, one digest over them, and where its summary block was inserted). On resume the archive is checked against it: a mismatch is reported with the covered ids and that compaction's archived messages are not used, and when the compaction's own output is gone from the saved conversation but the archive verifies, the full transcript is restored from the archive (CX-2). Older archives without a record resume exactly as before.
- `verificationPaths.mode: "block"` now also stops shell writes to verification files (CS-2, opt-in per the recorded decision D2; the default modes stay record-only): each `run_command` is fingerprinted before and after by file contents, and a change to a verification file (Makefile, CI, test config, verifier scripts, `package.json` scripts) is restored, refused as `VERIFICATION_CONFIG_PROTECTED` with the changed lines, and recorded as blocked. New runnable test files and non-verification `package.json` edits are unaffected.
- The literal secret patterns now live in one table, `cli/src/redaction_patterns.json`, which the TypeScript redactor is built from; the Rust sidecar-stderr redactor mirrors it. `cli/test/redaction_parity.test.ts` fails when either side adds, drops or edits a pattern without the other, and both sides run one shared corpus (`cli/test/fixtures/redaction_corpus.json`, with no key-shaped literal committed). Redaction behaviour is unchanged: the old and new TypeScript redactors agreed on 20,000 generated inputs. The other redaction and terminal-safe helpers are layered, not duplicates, and are unchanged (MT-3, part).
- `scripts/flake_report.mjs` and a weekly `flake-report` workflow record CI rerun events (a run that failed and then passed unchanged), name the failing tests from the earlier attempts' logs, and fail when a test needed a rerun in 2 of the last 20 runs; the JSON report is kept as an artifact. A failure fixed by pushing a new commit is not a rerun and is not counted (PC-3).
- `action/` is a composite GitHub Action that installs a pinned release and runs `nexus run --json`, failing the step unless the task completed and verified (exit code is the gate; `success`, `status`, `task-id` outputs; inputs reach the script only as environment variables). `examples/` adds a verified-completion task, a worktree run, an operation spec with `git.isolate` and a pull-request workflow; every one is run by `cli/test/examples.test.ts` (RD-4, DH-3).
- `nexus run --output stream-json` streams NDJSON events (start, assistant text, tool start/end, notices, result) on stdout and nothing else; `--output json` is `--json`. Schema in `docs/STREAM_JSON.md` (RD-3).
- A shipped catalog (`providers.catalog.json`) adds the OpenAI-compatible long tail as data: Mistral, Groq, Together AI, DeepSeek, xAI, Fireworks AI, Cerebras, Perplexity, Gemini, Cloudflare Workers AI, Azure OpenAI and Bedrock (OpenAI-compatible). Each has a recorded-fixture conversation test (text, tool call, reasoning, truncation, error); none was run against the live services (PR-5). An operator `providers.json` base URL is now optional.
- Behaviour now follows the selected model's listed capabilities (models.dev data), never assumed when absent: a model that lists no `tool_choice: required` is not sent a forced re-ask after the corrective note; per-model context and output limits sit between the operator/advertised values and the 65,536/8,192 defaults (source `snapshot`); `nexus doctor` warns when the configured reasoning effort is not one the model lists (PR-4).
- `nexus models refresh` (explicit, the only command that contacts models.dev) validates fresh model data and writes a private local cache that overrides the bundled snapshot; `nexus providers` shows which is in use and its date (PR-3).
- `nexus providers` marks operator-declared providers, `nexus doctor` gains `config.providers_file` (a declared provider without a credential warns), and `docs/CLOUD_PROVIDERS.md` documents `providers.json` (PR-12).
- Added a per-provider-definition wire matrix test (PR-11): every key-authenticated definition, built-in and operator-declared, is exercised for a streamed text reply and a tool call against a local mock, asserting path, query, the single credential header, static headers and omitted parameters.
- Operators can declare their own providers in `~/.config/nexus/providers.json` (operator home only; a project file is never read): id, label, protocol, a base URL template with validated `{variables}`, fixed query parameters, extra headers, and `bearer`, `x-api-key` or custom-header auth, with several named providers instead of one compatible slot. Errors name the field. Example: Azure OpenAI with a deployment path, `api-version` query and `api-key` header (PR-2 slice 3).
- Added `provider_safety` validation for operator-declared providers (id grammar, https-only unless local, no URL credentials, validated template variables, forbidden and auth headers refused); a provider base URL containing credentials is now refused (PR-9, groundwork for the operator providers file).
- Provider enumeration goes through one accessor (`allProviders()`/`providerIds()`), and a provider id that matches an inherited object key (`constructor`) is no longer treated as known (PR-2 slice 2).
- Provider definitions now carry per-model protocol rules (`protocolRules`) and a header-name auth style (`auth: "header"` with `authHeader`), replacing the hard-coded Copilot gpt-5 check. Built-in providers behave identically (PR-2 slice 1).

- Tool-call arguments a weak model writes as text are converted when the tool's schema makes the type unambiguous: `"20"` for an integer or number, `"true"`/`"false"` for a boolean, a JSON string for an array or object. Unions, enums, nested properties and guesses (wrapping a scalar in an array) are left alone. Such a call is counted as `schema` in `toolCallSyntax` and scores 0.5 in `json_repair_rate`, never as native valid (plan unit WM-1).
- The CLI parser moved to commander 14 (from 12). Commander 13 made extra positional arguments an error; Nexus keeps ignoring them as before (`nexus doctor extra` still runs doctor), so command-line behaviour is unchanged. The supported Node.js floor stays 22. Commander 15 needs Node.js 22.12.0 and is deferred until the floor moves.

### Fixed

- Protected-path matching is relative to the workspace root, so projects under directories such as `~/.env-tools/` are no longer blocked wholesale; symlinks to protected targets are still refused.

### Removed

- The unread `allowExternalSymlinks` policy key (files that set it still load; the key is ignored).

## [v1.2.0] - 2026-11-15

Release notes: [`docs/releases/v1.2.0.md`](docs/releases/v1.2.0.md). Candidate: [`rc.1`](docs/releases/v1.2.0-rc.1.md). Plan: [`docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md`](docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md).

### Changed

- **Breaking validation change:** `nexus operation run` now rejects a spec whose own `policy.maxConcurrentUnits` is above 1 unless it sets `git.isolate: true`, because concurrent units otherwise write the same worktree. Fix: add `"git": { "isolate": true }` or set the limit to 1. Records already on disk are not refused: `nexus operation resume` and `decide` clamp such a record to one unit at a time and warn. The library API `newOperation` is unchanged.

## [v1.1.4] - 2026-11-14

Release notes: [`docs/releases/v1.1.4.md`](docs/releases/v1.1.4.md). Candidate notes: [`rc.3`](docs/releases/v1.1.4-rc.3.md), [`rc.2`](docs/releases/v1.1.4-rc.2.md), [`rc.1`](docs/releases/v1.1.4-rc.1.md).

### Fixed

- A turn suspended while waiting out a provider's Retry-After (429/503) now resumes inside that window correctly: `nexus run --resume`, the TUI (`--resume`) and `nexus operation resume` wait until the recorded eligible time before the first request, shown as the usual provider-wait status, instead of sending it at once. The wait is skipped when you resume against a different endpoint, and bounded by the recovery deadline (`LOCAL_LLM_RECOVERY_DEADLINE_MS`, default 20 min); Ctrl-C during it suspends again with the same eligible time (#471).


## [v1.1.3] - 2026-11-05

See [`docs/releases/v1.1.3.md`](docs/releases/v1.1.3.md) (and candidate notes [`docs/releases/v1.1.3-rc.1.md`](docs/releases/v1.1.3-rc.1.md)). This release carries the whole v1.1.2 scope unchanged, with the same known limitations.

## [v1.1.2] - Not released (shipped as v1.1.3)

The `v1.1.2` tag was rejected by the release workflow (no `v1.1.2-rc.N` parent) and nothing was published; see [`docs/releases/v1.1.3.md`](docs/releases/v1.1.3.md).

See [`docs/releases/v1.1.2.md`](docs/releases/v1.1.2.md) for the full release notes and [`docs/releases/v1.1.2-qualification.md`](docs/releases/v1.1.2-qualification.md) for the qualification record. The date is set when the release is tagged.
Delivers the WP-1101 to WP-1108 roadmap (local OpenTelemetry tracing, flight-recorder redaction, versioned evaluation datasets, standalone `nexus eval`, deterministic code evaluators, single-step loop mode, bounded tool schemas with vLLM strict schemas, dependency modernisation), non-progress recovery and specialist orchestration, and fixes the duplicate re-injection of a multi-message prompt after a crash-resume. Ships with known limitations accepted by the owner; the 99.5% constrained-decoding target was not measured. Version numbers: no `v1.1.2-rc.*` was published.

## [v1.1.1] - 2026-11-01

See [`docs/releases/v1.1.1.md`](docs/releases/v1.1.1.md) (and candidate notes [`docs/releases/v1.1.1-rc.1.md`](docs/releases/v1.1.1-rc.1.md)) for full release notes.
Promoted release line delivering multi-agent orchestration, serialized git integration, typed inter-agent channels, operation replay, context-budget provenance, cancellation idempotency, durability-positive message acknowledgment, structured prompt provenance, and protected replay envelope error propagation.

## [v1.1.0] - 2026-10-31

See [`docs/releases/v1.1.0.md`](docs/releases/v1.1.0.md) (and candidate notes [`docs/releases/v1.1.0-rc.1.md`](docs/releases/v1.1.0-rc.1.md)) for full release notes. Scope and acceptance:
[`docs/v1.1.0/SPEC.md`](docs/v1.1.0/SPEC.md), [`docs/v1.1.0/REQUIREMENTS.md`](docs/v1.1.0/REQUIREMENTS.md).

### Added
- **Deterministic parallel work units:** `policy.maxConcurrentUnits` (default 1, bounded at 64) and
  `resources[].maxConcurrentUnits` (default 1). The scheduler returns an ordered due-set — required units first, then
  the longest unfinished dependent chain, then declaration order — and reserves per-resource slots. A unit whose
  qualified slots are busy stays runnable instead of being parked or blocked.
- **Serialised git integration queue:** concurrent isolated units merge one at a time into the operation branch, with
  `INTEGRATION_QUEUED` / `INTEGRATION_SKIPPED` events and receipts that now name the candidate digest, the executed
  tests and the 1-based merge sequence.
- **Typed inter-agent channel:** `request`, `observation`, `artifact` and `verdict` messages persisted in the operation
  record, delivered at most once to a unit or the whole operation; completed units publish their verified summary, and
  `nexus operation message` lets the operator publish one.
- **Operation replay:** `nexus operation status --replay [--json]` renders the recorded timeline, oldest first, with
  contiguous step indices. The view document is now schema version 2.
- **Context-budget provenance:** a `CONTEXT_BUDGET` block names the binding bound, the estimate and its source
  (`operator-budget` or `agent-estimate`), and `unit.context` records the source.

### Changed
- **Operation document schema 2:** a v1.0.0 operation record migrates in memory, gains `schemaVersion: 2`, and is
  copied byte-for-byte to `<record>.pre-migration-v1` before its first v2 write. A record from a newer build is refused
  with a one-line error and is **not** quarantined.
- **Strict operation specs:** unknown top-level, unit, `requires`, `policy`, `git` and resource keys are rejected with
  exit 2 and a suggested key. `git.publish` is rejected explicitly instead of being silently ignored.
- **View schema 2:** the checked-in `operation-view.schema.json` version and its test validator now agree; the
  validator enforces `minimum`, `maximum`, `minItems`, `pattern` and `maxLength` as well as the structural keywords.

### Fixed
- **Terminal safety in the operation view:** `view.status` and `unit.status` are rendered through `safeTerminal`, so a
  tampered or corrupt record cannot emit control or OSC sequences through a status field.

### Deferred
- PR publication (`git.publish`), the TUI operation pane, in-view decision interaction, semantic retrieval over
  operation records, and a unit-authored message tool. Each has a dated rationale in
  [`docs/v1.1.0/DECISIONS.md`](docs/v1.1.0/DECISIONS.md).

## [v1.0.0] - 2026-10-31

See [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md) for full release notes.

### Added
- **Packaged Product Parity:** Packaged binary launches the live Ratatui terminal UI on interactive TTYs, while falling back cleanly to the REPL when standard input is redirected (`</dev/null`).
- **Third-Party Notices:** Automated third-party notice generation (`THIRD_PARTY_NOTICES.txt`) covering 100% of Rust crates and npm production dependencies with license texts (`about.toml`, `about.hbs`).
- **CycloneDX SBOM:** Merged CycloneDX 1.5 JSON Software Bill of Materials (`sbom.cdx.json`) derived directly from lockfiles and validated in CI.
- **Build Provenance:** Cryptographic build provenance attestations via GitHub Actions artifact attestations (`actions/attest-build-provenance`). The installer supports optional verification using `gh attestation verify`.
- **Security Policy:** Private vulnerability intake and disclosure policy defined in [`SECURITY.md`](SECURITY.md).
- **Toolchain Pinning:** Rust toolchain pinned to 1.95.0 (`rust-toolchain.toml`, `rust-version = "1.85.0"`), Node.js pinned to `>=22`.
- **CI Test Matrix:** Multi-version Node testing across Node 22 and 24.
- **Reproducible Builds:** Byte-identical package generation across clean builds (`make verify-reproducibility`, `repro.yml`).

### Changed
- **Launcher Syntax:** Unknown commands fail explicitly; arbitrary execution requires explicit `nexus run "<task>"`.
- **Distribution Hygiene:** Untracked built TypeScript artifacts (`cli/dist`) from version control. `harness.sh` warns helpfully if `cli/dist` is not yet built.
- **Security Gates:** Security gate script (`security_gates.sh`) hardened to fail closed if neither `cargo-deny` nor `cargo-audit` is installed; removed toy fallback.

### Fixed
- **Upgrade Power-Loss Durability:** The extracted release package is fsynced before it is renamed into place and the launcher is switched. Previously a rename persisted only the directory entry, so a power loss shortly after an upgrade could leave the live launcher pointing at zero-length binaries, making `nexus upgrade --recover` itself unavailable.

## [v0.1.0-alpha.2] - 2026-10-14

See [`docs/releases/v0.1.0-alpha.2.md`](docs/releases/v0.1.0-alpha.2.md) for full release notes.

### Added
- **Durable Compaction:** State compactions are committed in sequence with fsync; compaction errors fail closed as `PERSISTENCE_FAILED`.
- **Provider Discovery:** Context size and output allowance dynamically discovered from provider `/models` endpoints.
- **Token Accounting:** Exact request token counting via `/v1/tokenize` when advertised by gateway.

### Changed
- **Long Tasks & Compaction:** Removed arbitrary 300-step / 120-minute defaults; turn continues across durable segment checkpoints while making progress.
- **Loop & Repetition Detection:** State-aware action repetition checks against workspace snapshot diffs.
- **Length Recovery:** Clean handling of truncated model replies (`finish_reason=length`) without aborting on first occurrence.

## [v0.1.0-alpha.1] - 2026-10-13

See [`docs/releases/v0.1.0-alpha.1.md`](docs/releases/v0.1.0-alpha.1.md) for full release notes.

### Added
- **Initial Alpha:** Initial package release for Linux x86-64 with glibc 2.35+.
- **Components:** Combined TypeScript CLI/sidecar, Rust `harness-core` workspace tools, and Ratatui `nexus-tui`.
- **Installer:** Self-contained one-line shell installer (`install.sh`) with SHA-256 integrity validation.
