# Cloud inference providers

Nexus runs against the local appliance by default. Cloud providers are opt-in, selected explicitly by the operator,
and use their own credentials. Nothing in this document changes how the appliance is reached.

| Provider id | Protocol | Default base URL | Credential variable |
|---|---|---|---|
| `openrouter` | OpenAI Chat Completions (+ usage/cost reporting) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai` | OpenAI Responses (stateless, `store: false`) | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `compatible` | OpenAI Chat Completions, any service | none — must be configured | `NEXUS_COMPATIBLE_API_KEY` |
| `chatgpt` | OpenAI Responses via the ChatGPT Codex backend | `https://chatgpt.com/backend-api/codex` | sign-in only (**unofficial**) |
| `copilot` | Chat Completions (Responses for `gpt-5*`) | `https://api.githubcopilot.com` | sign-in only (**unofficial**) |

## Choosing a model and connecting providers in the live view

- `/model` opens the picker: **Recent**, then the appliance and each connected provider with its models (the current
  one marked ●) and where its credential comes from; providers not yet connected show **+ Connect …**. Type to
  filter by provider or model, ↑↓ to move, Enter to switch. The switch applies to every role and the next turn.
- **ctrl+p** in the picker (or `/connect`) opens **Connect a provider**: ✓/○ status per provider, then its methods:
  - **API key** — paste or type it (shown as •••• only); Nexus lists the provider's models with it and saves it only
    if that works.
  - **Sign in with OpenRouter** — OpenRouter's official PKCE flow for apps; it issues a user API key.
  - **Sign in with ChatGPT (unofficial)** — the Codex CLI's browser sign-in, for ChatGPT Plus/Pro plans.
  - **Sign in with GitHub (unofficial)** — the VS Code Copilot device-code sign-in, for Copilot subscriptions.
  After connecting, the picker reopens on that provider's models. **ctrl+d** removes Nexus's saved credential.
- Without the live view: `/model` lists everything as text, `/model <provider> <model>` switches
  (`/model appliance qwen2.5-coder` returns to the appliance), `nexus connect <provider> [--method <id>]` (key typed
  hidden or piped on stdin) and `nexus disconnect <provider>`.

**Unofficial sign-ins** reuse another vendor's OAuth client identity (Codex CLI, VS Code Copilot), as opencode and
crush do. OpenAI and GitHub do not offer these to third-party apps; their terms may not permit it. They are labelled
in the UI and were included at the operator's explicit request.

## Where credentials come from

In order: the provider's environment variable → Nexus's store `~/.config/nexus/credentials.json` (mode 0600,
written atomically) → a connection already registered in another client, read in place:

| Client | File | Used for |
|---|---|---|
| Codex CLI | `~/.codex/auth.json` | `chatgpt` |
| opencode | `~/.local/share/opencode/auth.json` | API keys (`openrouter`, `openai`, `anthropic`), `openai` OAuth → `chatgpt`, `github-copilot` → `copilot` |
| crush | `~/.local/share/crush/crush.json` | `providers.*.api_key` (not `$VAR` references), OAuth tokens |
| GitHub Copilot plugins | `~/.config/github-copilot/apps.json`, `hosts.json` | `copilot` (GitHub token) |

Nexus never writes those files and never refreshes another client's OAuth token (refresh tokens rotate, so doing so
would sign that client out). An expired token is re-read on each request; if it is still expired, Nexus asks you to
use that client once or sign in from Nexus. A Copilot GitHub token from a plugin is exchanged for a short-lived
Copilot token in memory (nothing rotates). Nexus-owned sign-ins are refreshed before expiry, and once more after a 401.

## Setup

1. Put the key in your environment or `~/.config/nexus/config.env` (mode 600), e.g. `ANTHROPIC_API_KEY=...`.
2. Select a provider and model, per run or as your default:

   ```bash
   nexus run --provider anthropic --model claude-sonnet-4-5 "..."
   # or in ~/.config/nexus/config.env
   NEXUS_PROVIDER=openrouter
   NEXUS_MODEL=anthropic/claude-sonnet-4.5
   ```

   Model ids are passed verbatim (slashes and `:free`-style suffixes are fine). There is no auto-detected cloud
   model: an unset model is a configuration error.
3. Check it: `nexus providers` shows each provider, whether its credential is set (never its value), each role's
   destination and the authorized cloud destinations. `nexus providers verify --provider <id> --model <m>` performs a
   live check — a streamed completion and a tool round trip — sending no workspace content.

Roles: `--planner-provider/--planner-model` and `--coder-provider/--coder-model` (or `PLANNER_LLM_PROVIDER`,
`CODER_LLM_PROVIDER`) bind a role to a provider. A role without its own provider uses its own `--*-endpoint` if
given, else the main connection. Subagents, the LLM compaction summary and scheduled work units inherit the main
connection unless an operation spec resource names `"providerId"`. Embeddings are never sent to a cloud provider
(search falls back to lexical).

Other settings: `--base-url` / `NEXUS_<ID>_BASE_URL` (override, e.g. a regional endpoint; required for
`compatible`), `NEXUS_COMPATIBLE_AUTH=none` (declare an auth-less compatible service), `NEXUS_REASONING_EFFORT`
(OpenAI reasoning effort), `NEXUS_ANTHROPIC_THINKING_BUDGET` (Anthropic extended thinking, ≥ 1024),
`--context-limit` (cloud models keep the conservative 65536 default unless you set the real window).

## Authority and disclosure

- Only the operator selects a cloud destination: command-line flags, the operator's own environment, or
  `~/.config/nexus/config.env`. A project `.env` cannot set `NEXUS_PROVIDER`, `*_LLM_PROVIDER` or a provider base URL
  (it is ignored with a warning). A cloud endpoint that only a project `.env` chose is refused before anything is sent.
- Workspace `.env` isolation: project `.env` files are parsed into an isolated effective configuration layer and
  are never written into `process.env`. Only allowlisted keys (`LOCAL_LLM_ENDPOINT`, `LOCAL_LLM_MODEL`,
  `LOCAL_LLM_TASK_CLASS`, `NEXUS_CONTEXT_LIMIT`, and `NEXUS_PROJECT_*`) are accepted from project `.env`. All other
  keys—including provider credentials, `NODE_TLS_REJECT_UNAUTHORIZED`, `HTTPS_PROXY`, `HOME`, timeouts, recovery
  policies, and fallback endpoints—are ignored.
- **Locality classification (REQ-SEC-111)**: Nexus distinguishes local appliances from external/cloud destinations
  strictly from parsed IP literals and CIDR blocks:
  - IP literals are classified by CIDR: loopback (`127.0.0.0/8`, `::1`), RFC-1918 private subnets (`10.0.0.0/8`,
    `172.16.0.0/12`, `192.168.0.0/16`), Carrier-grade NAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`, `fe80::/10`),
    and IPv6 Unique Local Addresses (`fc00::/7`). IPv4-mapped IPv6 addresses (`::ffff:...`) are unwrapped and checked
    against the same CIDRs.
  - Hostnames are treated as external destinations unless the host is `localhost`, matches the operator's configured
    endpoint, or is explicitly listed in `NEXUS_LOCAL_ORIGINS`.
  - DNS resolution is explicitly never used to grant local status to hostnames, preventing DNS-rebinding attacks where an
    external domain resolves to a private IP to bypass disclosure.
  - **`NEXUS_LOCAL_ORIGINS`**: Operators with LAN or Tailscale inference servers (e.g. `gpubox:8000`, `lan-llm.home`) can
    declare them local by setting `NEXUS_LOCAL_ORIGINS="gpubox:8000,lan-llm.home"` in their environment or in
    `~/.config/nexus/config.env`. This setting is operator-only; project `.env` cannot set it.
  - The first outbound request and `nexus doctor` report the classification reason code:
    - `loopback_ip`: Loopback address (`127.0.0.0/8`, `::1`).
    - `private_ip`: RFC-1918 private IPv4 or IPv4-mapped equivalent.
    - `cgnat_ip`: CGNAT address (`100.64.0.0/10`).
    - `ula_ip`: IPv6 Unique Local Address (`fc00::/7`).
    - `operator_local_origin`: Origin/host explicitly listed in `NEXUS_LOCAL_ORIGINS`.
    - `operator_endpoint`: Host matches the operator-configured local appliance endpoint.
    - `hostname_external`: Hostname not declared local by the operator (requires disclosure).
- The first request to each cloud origin prints a notice that task content (prompts, tool results, file excerpts) is
  sent there, along with the classification reason. Secret tokenization (`InformationFlowBoundary`) still applies to every
  outbound request.
- Local-to-cloud fallback is off: a fallback endpoint that is a cloud destination is skipped unless its origin is in
  `NEXUS_CLOUD_DISCLOSURE_ORIGINS`. Provider connections never use the appliance fallback list.
- `NEXUS_CLOUD_ROUTED_ORIGINS` marks local-looking origins that forward to a cloud service; they are then treated as
  cloud destinations (authorization required).

## Credentials

Each provider's key is bound to its connection's origin. A provider connection never receives the appliance gateway
token, `LOCAL_LLM_API_KEY`, or another provider's key, and the appliance never receives a cloud key. Provider requests
refuse redirects so a key cannot follow a server to another origin. Keys are never persisted in sessions, task state
or receipts; provider error bodies are bounded and redacted.

## Failures and recovery

Provider failures are typed: `AUTH_FAILURE` (401/403), `QUOTA_EXHAUSTED` (402, `insufficient_quota`, billing),
`RATE_LIMITED` (429, honours `Retry-After`), `OVERLOADED` (529/503, overloaded error events), `CAPACITY_REJECTED`
(context too long), `REQUEST_REJECTED`, transport timeouts/interruptions. Temporary conditions are waited out by the
existing bounded recovery loop for the same target; auth, quota and request errors stop the turn. A response is used
only when the provider's terminal event arrives: an incomplete stream, `max_tokens` truncation or an error frame
discards the partial output and no tool call from it runs. Explicit selections are strict — there is no automatic
switch to another provider or model, including after a refusal.

## Usage, cost and limits

Every provider request (main, planner/coder, subagent, compaction, verification) records a receipt in
`<workspace>/.nexus/inference_receipts.jsonl`: role, provider, selected and effective model, origin, protocol,
outcome, provider request id, reported usage, and cost confidence. Cost is recorded only when the provider reports it
(OpenRouter); otherwise it is `unknown` — never estimated. `/tokens` and `nexus run` show a cloud usage summary;
`run -j` adds `cloudUsage`.

Process-wide limits, shared by all roles and subagents and enforced before each provider-connection request (a plain
`--endpoint` that happens to be a cloud host is disclosure-gated but neither metered nor limited):
`NEXUS_CLOUD_MAX_REQUESTS`, `NEXUS_CLOUD_MAX_TOKENS` (reported tokens plus in-flight reservations),
`NEXUS_CLOUD_MAX_COST_USD` (only for providers that report cost; with any other provider the request is refused
rather than guessed). These are budgets, not a guarantee of the provider's invoice.

## Troubleshooting

| Message | Meaning |
|---|---|
| `No credential for provider 'x': set X_API_KEY` | The provider's own key is missing; nothing was sent. |
| `Refusing to send task content to ...: cloud destination the operator has not authorized` | Selected by a project `.env`, a fallback, or a cloud-routed origin: select it explicitly or list it in `NEXUS_CLOUD_DISCLOSURE_ORIGINS`. |
| `Notice: cloud inference destination ... (hostname_external)` | Hostname is not loopback, private IP, or configured endpoint. If it is a LAN/Tailscale server, set `NEXUS_LOCAL_ORIGINS` in your environment or `~/.config/nexus/config.env`. |
| `Notice: ignoring project .env key '...'` | Key is not on the project allowlist. Move credentials, proxies, or operator flags to `~/.config/nexus/config.env`. |
| `Cloud spending limit: ...` | A `NEXUS_CLOUD_MAX_*` limit was reached. |
| `reasoning state owned by another provider/model ... not replayed` | History came from another model; its opaque reasoning is dropped, text and tool calls kept. |
| `Provider 'x' needs an explicit model` | Pass `--model` or set `NEXUS_MODEL`. |

## Limitations

- Implemented: OpenRouter, OpenAI (Responses), Anthropic (Messages), generic OpenAI-compatible, ChatGPT plan and
  GitHub Copilot (unofficial sign-ins). Not implemented: Gemini, Azure OpenAI, Bedrock, Vertex, Anthropic
  Claude Pro/Max sign-in, GitHub Enterprise Copilot.
- The ChatGPT Codex backend and Copilot request formats follow crush's implementation and are verified against mocks
  only; they can change without notice.
- No cross-provider model-fallback chain; recovery stays on the selected target.
- Model catalog lists are cached per provider in `~/.cache/nexus/models` and used as fallback when offline; no embedded per-model pricing metadata: set `--context-limit` for large windows.
- Provider-hosted tools (web search, code execution) are not enabled; all tools run through Nexus authorization.
- Opaque reasoning state is replayed only to the exact provider+model that produced it and only if unaltered;
  persistence redaction can alter it, in which case it is dropped (not forwarded) after a restore.
