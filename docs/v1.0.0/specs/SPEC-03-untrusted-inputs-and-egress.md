# SPEC-03: Untrusted workspace inputs and the egress boundary

| | |
|---|---|
| Status | Ready. EXT-004 to be implemented and CTX-001 partially, per [DEC-04](../DECISIONS.md#dec-04-issue-12-open-normative-blockers); knowledge auto-extraction off by default per DEC-15. |
| Release class | **BLOCKER**: `.env` override, locality classification, foreign plugin directory. RELEASE-REQUIRED: SSRF, skills trust, knowledge extraction, protected-path hardening. |
| Requirements | REQ-SEC-110, REQ-SEC-111, REQ-SEC-112, REQ-SEC-113, REQ-SEC-114, REQ-SEC-115, REQ-SEC-116, REQ-SEC-117, REQ-PRV-108 |
| Findings | PRV-01, PRV-02, PRV-08, SEC-03, SEC-05, SEC-06, AGT-10, HIST-04, HIST-01 (EXT-004), PRV-15, SEC-09, HIST-03 |
| Plan | [PLAN-03](../plans/PLAN-03-untrusted-inputs-and-egress.md) |
| Acceptance | ACC-TRUST-01 to ACC-TRUST-09 |

## 1. Problem

Nexus's threat model, as its docs state it, is that the operator's own configuration (`~/.config/nexus`) holds authority. An opened workspace is data until the operator trusts it (USER_MANUAL §4; `cli/src/workspace_trust.ts`). Workspace MCP configs and plugins honour this: they need `nexus trust` and never run in `--read-only`. Several other inputs that come from the workspace or the network do not:

| Input | Current behaviour | Finding |
|---|---|---|
| Workspace `.env` | Loaded with `override:true` and no key filter (`cli/src/config.ts:36-39`). `NODE_TLS_REJECT_UNAUTHORIZED=0` from a repo disables TLS verification for every later fetch, including cloud API keys. Reproduced. It can also set timeouts, recovery policy, `LOCAL_LLM_FALLBACK_ENDPOINTS` and provider key vars, because `credentials.ts:243` reads live env. | PRV-01 (S2) |
| Destination locality | `classifyDestination` treats hostnames starting with `10.`/`192.168.`, or ending `.local`, as local (`cli/src/core/egress.ts:134-139`). `http://10.attacker.example/v1` is "LOCAL_APPLIANCE", so the documented rule that a cloud endpoint chosen only by a project `.env` is refused is bypassable. Reproduced. Conversely, `127.0.0.2`, Tailscale `100.64/10`, IPv6 ULA and bare LAN hosts are classified as cloud. | PRV-02 (S2), PRV-08 (S3) |
| `fetch_web` | Hostname-string SSRF guard. No DNS resolution. Follows redirects. `localtest.me` and `[::ffff:127.0.0.1]` reached a loopback-only server. Reproduced. Never needs approval. Reads the whole body before truncating (`cli/src/tools.ts:52-111,653-662`). | SEC-03 (S2) |
| Workspace skills | `./skills`, `./.nexus/skills` and `./.claude/skills` are loaded into the system prompt with no trust check (`cli/src/skills.ts:31-33`, `agent.ts:3301`). `activate_skill` is never approved. | SEC-05 (S2) |
| Workspace knowledge | `<ws>/.nexus/knowledge.json` is injected into every system prompt without a trust gate. After every turn, `autoExtract` mines the prompt for `always|never|must…` phrases and saves them as permanent rules. `.nexus/` is created even in `--read-only` (`cli/src/knowledge.ts:34-43,206-231`; `agent.ts:4934-4936`). | AGT-10 (S3) |
| Foreign plugin directory | Every `*.js`/`*.mjs` in `~/.config/opencode/plugins` is imported in-process at turn start. This is undocumented (`cli/src/plugins.ts:47-54`). | HIST-04 (S2) |
| Plugin middleware | `executeToolPipeline` pre/post hooks can rewrite tool args and results with no before/after audit record. This is EXT-004, open since Issue #12 (`plugins.ts:150-200`). | HIST-01 |
| Plugin "sandbox" | `executeSandboxed` (worker + eval) is not an isolation boundary and has no callers. USER_MANUAL.md:294 promises worker-thread isolation with memory caps. | SEC-09, HIST-03 |
| `search_web` | Defaults to DuckDuckGo. When nothing is found it returns a fabricated "result" marked success (`cli/src/search_web.ts:49,94,143-152`). | PRV-15 (S3) |
| Protected paths | The name-pattern check misses `.env.local`, `.env.production`, `secrets/.npmrc` and case variants. `run_command cat .env` is unchecked (`cli/src/security.ts:25-32,91-108`). | SEC-06 (S3) |

## 2. Requirements

1. **REQ-SEC-110.** A workspace `.env` may set only an allowlisted set of keys: `LOCAL_LLM_ENDPOINT`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_TASK_CLASS`, `NEXUS_CONTEXT_LIMIT`, plus any key in the documented `NEXUS_PROJECT_*` namespace. All other keys are ignored, with one warning per key at startup and in `nexus doctor`. In particular it may not set `NODE_*`, `*_PROXY`, `HOME`, `PATH`, `SSL_*`, credential variables, timeouts, recovery policy or fallback endpoints. Project values are kept in a separate map and are never written into `process.env`.
2. **REQ-SEC-111.** Destination locality is decided from parsed addresses:
   - IP literals are classified by CIDR: loopback 127/8 and ::1; RFC1918; CGNAT 100.64/10; link-local; ULA fc00::/7; v4-mapped addresses unwrapped.
   - Hostnames are external unless they are `localhost`, the host of the operator-configured endpoint, or listed in operator-only `NEXUS_LOCAL_ORIGINS`.
   - DNS resolution is not used to grant locality.
3. **REQ-SEC-112.** `fetch_web`:
   - resolves the host and refuses non-public addresses (unless the origin is operator-allowlisted);
   - pins the resolved address for the connection;
   - uses `redirect: "manual"` and re-checks every hop (maximum 5);
   - streams the body with a 5 MB cap;
   - is gated per SPEC-01 `egress`.
4. **REQ-SEC-113.** Workspace skills and workspace `knowledge.json` are loaded only for trusted workspaces. In an untrusted workspace they are listed by `/skills` as "untrusted (not loaded)", and `activate_skill` on one is refused with the `nexus trust` hint.
5. **REQ-SEC-114.** No implicit standing instructions:
   - `autoExtract` is removed, or opt-in through `NEXUS_KNOWLEDGE_AUTOEXTRACT=1` with a visible notice each time a rule is saved;
   - `--read-only` performs no workspace writes, including `.nexus/` creation.
6. **REQ-SEC-115.** Nexus loads plugins only from its own documented directories (`~/.config/nexus/plugins`, `~/.nexus/plugins`, and trusted workspace dirs). `~/.config/opencode/plugins` is removed.
7. **REQ-SEC-116.** EXT-004: every middleware change to tool args or results emits an audit record with the before and after digests and the plugin id. DEC-04 resolved this as implement.
8. **REQ-SEC-117.** The plugin "sandbox" claim is removed from code and docs, or made true. `executeSandboxed` is deleted.
9. **REQ-PRV-108.** `search_web`:
   - returns `success:false` / an empty result when nothing is found;
   - its default destination is disclosed in docs and on first use;
   - it goes through the disclosure gate.
10. **REQ-SEC-118 (release-required).** Protected-path matching covers `.env*` and canonical target names on every read tool, case-insensitively on case-insensitive filesystems. It is documented as advisory for `run_command`.

## 3. Proposed design

### 3.1 Configuration layering (`cli/src/config.ts`)

```
operatorEnv   = process.env at startup (snapshot)
operatorFile  = ~/.config/nexus/config.env           (override operatorEnv for nexus keys only)
installDefaults = <install>/cli/.env                  (lowest; no override)
projectEnv    = dotenv.parse(<workspace>/.env)        (never written to process.env)
effective     = resolve(key) = operator* ?? projectEnv[key] if key ∈ PROJECT_ALLOWLIST ?? installDefaults
```

Replace every `process.env.X` read in `client.ts`, `credentials.ts`, `config.ts` and `provider_recovery.ts` with `effective.get("X")`. `grep -n "process.env" cli/src` gives the inventory. The credential-authority snapshot that already exists (`client.ts:77-101`) becomes the `operator*` layer.

Ignored project keys are reported as `config.project_env_ignored` in doctor JSON and printed once at session start.

### 3.2 Locality (`cli/src/core/egress.ts:107-160`)

Use `net.isIP` plus a small CIDR table. Return `{ boundary, reason }` where the reason is one of `loopback_ip`, `private_ip`, `cgnat_ip`, `ula_ip`, `operator_local_origin`, `operator_endpoint`, `hostname_external`. Show the reason in the "Cloud inference" notice and in doctor, so a user with a LAN hostname knows to set `NEXUS_LOCAL_ORIGINS`.

### 3.3 SSRF-safe fetch (`cli/src/tools.ts`)

Add `safeFetch(url, { maxBytes, maxRedirects })`:

1. Parse the URL and allow only http and https.
2. Resolve with `dns.lookup(host, { all: true })` and reject if any address is non-public.
3. Connect through an `undici` Agent with a `connect.lookup` that returns the pinned address.
4. Handle redirects manually, repeating steps 1–3 on each hop.
5. Read the body through a counting stream and abort at `maxBytes`.

### 3.4 Trust-gated context

In `skills.ts:31-33`, split skill roots into home roots (always) and workspace roots (only if `isWorkspaceTrusted(ws, readOnly)`). In `knowledge.ts`, apply the same gating for loading, make the constructor lazy (no `mkdir`), and add an opt-in flag for `autoExtract`. The model-facing system prompt marks injected skill and knowledge content with its source path and trust state. This is a partial answer to CTX-001 (provenance per injected item) and is recorded in DEC-04.

### 3.5 Plugins

- Delete `~/.config/opencode/plugins` from `plugins.ts:47-54`.
- Delete `executeSandboxed`.
- Implement the EXT-004 audit: wrap each pre/post hook and compare `sha256(JSON.stringify(before))` with the digest after the hook. On a difference, call `auditLog.record({ kind: "middleware_rewrite", plugin, tool, phase, before_digest, after_digest })` and add a line to the flight log.
- Fix USER_MANUAL.md:294 to say plugins run in-process with full user authority.

## 4. Compatibility

- Users who relied on a project `.env` for `NODE_EXTRA_CA_CERTS` or proxies must move them to `~/.config/nexus/config.env` or the shell env. Document a custom CA properly (PRV-18, SPEC-05).
- Users with LAN or Tailscale inference hosts must set `NEXUS_LOCAL_ORIGINS`, or configure that host as their operator endpoint, which is automatically local (`operator_endpoint`).
- Untrusted repos with `.claude/skills` lose automatic skill loading until trusted. Release notes must say so.

## 5. Security notes

These changes close the remaining routes by which workspace content becomes authority:

- process environment;
- destination classification;
- standing instructions;
- foreign code.

Together with SPEC-01, an untrusted repo can still influence the model through file contents, which is unavoidable. But it cannot change Nexus's configuration, disclosure decisions or unapproved actions.

## 6. Alternatives

| Alternative | Why not chosen |
|---|---|
| Stop loading the project `.env` entirely | Breaks the documented per-project endpoint/model workflow (CLOUD_PROVIDERS.md). An allowlist keeps it. |
| Resolve DNS to decide locality | A DNS-rebinding risk, and makes the classification non-deterministic. |

## 7. Acceptance criteria

| ID | Check |
|---|---|
| ACC-TRUST-01 | `prv/tls.mts` (evidence): after `loadEnvironment()`, a self-signed cert is still rejected and `NODE_TLS_REJECT_UNAUTHORIZED` is unchanged. One test per denied key class. |
| ACC-TRUST-02 | Classification table test: `10.attacker.example` and `192.168.evil.com` → external, and policy_denied when unauthorized. `10.0.0.5`, `192.168.1.2`, `127.0.0.2`, `100.101.102.103`, `[fd00::1]` → local. `gpubox` → external unless it is in `NEXUS_LOCAL_ORIGINS`. |
| ACC-TRUST-03 | `fetch_web` refuses `localtest.me`, `[::ffff:127.0.0.1]`, `[fd00::1]`, `100.64.0.1`, and a public URL that 302-redirects to 127.0.0.1 (local test redirector). A 50 MB body is truncated at 5 MB with RSS < 100 MB. |
| ACC-TRUST-04 | Untrusted fixture repo with `skills/x/SKILL.md` and `.nexus/knowledge.json`: neither appears in the system prompt sent to the mock gateway. After `nexus trust .` both appear, with a source annotation. |
| ACC-TRUST-05 | A turn with prompt "never run the tests" does not change `knowledge.json` (default config). A `--read-only` run creates no `.nexus/`. |
| ACC-TRUST-06 | A sentinel plugin in `~/.config/opencode/plugins` is not imported (sentinel file not written). |
| ACC-TRUST-07 | A plugin rewriting `write_file.content` produces an audit record with differing digests . |
| ACC-TRUST-08 | `search_web` with a mock returning no results → `success:false`. |
| ACC-TRUST-09 | `read_file .env.local` / `.ENV` (case-insensitive FS fixture) is refused per policy. |

## 8. Dependencies

- SPEC-01 provides the `egress` and `context_inject` gating.
- SPEC-05 provides custom CA documentation.
- DEC-04 (resolved): EXT-004 is implemented, CTX-001 partially through §3.4, and CTX-002 is descoped post-v1.
