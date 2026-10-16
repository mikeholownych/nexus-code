# Standalone Local Inference Servers

Nexus Code connects directly to standalone OpenAI-compatible local inference servers without requiring any external gateway. This guide covers setup, automatic context window discovery, capacity recovery, timeouts, and custom TLS certificate authorities for **LM Studio**, **llama.cpp**, **vLLM**, and **Ollama**.

---

## 1. Quick Setup by Server Kind

Store your local endpoint settings in `~/.config/nexus/config.env` (mode `0600`):

```sh
mkdir -p "$HOME/.config/nexus"
chmod 700 "$HOME/.config/nexus"
```

### LM Studio (`http://127.0.0.1:1234/v1`)
1. Open LM Studio, load a tool-capable coding model (for example `qwen2.5-coder`), and start the local server on port `1234`.
2. Configure `~/.config/nexus/config.env`:
   ```dotenv
   LOCAL_LLM_ENDPOINT=http://127.0.0.1:1234/v1
   LOCAL_LLM_MODEL=qwen2.5-coder-7b-instruct
   LOCAL_LLM_API_KEY=local
   ```
3. **Context discovery:** LM Studio's `/v1/models` catalog does not include the loaded context length. Nexus automatically probes `GET /api/v0/models` (2 s timeout, cached per session) and reads `loaded_context_length` (falling back to `max_context_length`), reporting `server_probe (lmstudio)` in `/status` and `nexus doctor`.

### llama.cpp (`llama-server`, `http://127.0.0.1:8080/v1`)
1. Start `llama-server` with `--jinja` enabled so native OpenAI tool calls are parsed:
   ```sh
   llama-server -m /path/to/model.gguf --ctx-size 32768 --jinja --port 8080
   ```
2. Configure `~/.config/nexus/config.env`:
   ```dotenv
   LOCAL_LLM_ENDPOINT=http://127.0.0.1:8080/v1
   LOCAL_LLM_MODEL=model.gguf
   LOCAL_LLM_API_KEY=local
   ```
3. **Context discovery:** Nexus recognizes `llama.cpp` from its `/v1/models` entry (`owned_by: "llamacpp"` or `meta.n_ctx_train`) and probes `GET /props` (2 s timeout) for `default_generation_settings.n_ctx`, reporting `server_probe (llamacpp)` in `/status` and `nexus doctor`.

### vLLM (`http://127.0.0.1:8000/v1`)
1. Start vLLM with the appropriate tool-call parser for your model family (`hermes`, `qwen`, `llama3_json`, etc.):
   ```sh
   vllm serve Qwen/Qwen2.5-Coder-7B-Instruct \
     --max-model-len 32768 \
     --enable-auto-tool-choice \
     --tool-call-parser hermes \
     --port 8000
   ```
2. Configure `~/.config/nexus/config.env`:
   ```dotenv
   LOCAL_LLM_ENDPOINT=http://127.0.0.1:8000/v1
   LOCAL_LLM_MODEL=Qwen/Qwen2.5-Coder-7B-Instruct
   LOCAL_LLM_API_KEY=local
   ```
3. **Context discovery:** vLLM publishes `max_model_len` directly in `GET /v1/models`. Nexus reads it from the catalog entry and reports `provider_advertised` in `/status` and `nexus doctor`.

### Ollama (`http://127.0.0.1:11434/v1`)
1. Pull and serve a model with Ollama:
   ```sh
   ollama pull qwen2.5-coder:7b
   ```
2. Configure `~/.config/nexus/config.env`:
   ```dotenv
   LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/v1
   LOCAL_LLM_MODEL=qwen2.5-coder:7b
   LOCAL_LLM_API_KEY=local
   ```
3. **Context discovery:** When `/v1/models` omits limits, Nexus probes `POST /api/show` with `{"model": "<id>"}` (2 s timeout) and reads `num_ctx` from `parameters` (or `model_info["<arch>.context_length"]`), reporting `server_probe (ollama)` in `/status` and `nexus doctor`.

---

## 2. Context Sizing Precedence and Overrides

Nexus resolves the effective context window in the following order:

1. **Server / provider advertisement (`provider_advertised` or `server_probe (<kind>)`):** Read from `/v1/models` (`context_length` or `max_model_len`) or the server-specific probe (`/props`, `/api/v0/models`, `/api/show`), intersected with `--context-limit` if both are present.
2. **Operator override (`operator_override`):** Set via `--context-limit <tokens>` on the command line or `NEXUS_CONTEXT_LIMIT=<tokens>` in `~/.config/nexus/config.env` or project `.env`.
3. **Client default (`client_default`):** `65536` tokens when neither the server nor the operator specifies a limit.

To disable extra server-kind probes (`/props`, `/api/v0/models`, `/api/show`) and rely strictly on `/v1/models` or `NEXUS_CONTEXT_LIMIT`, set `NEXUS_SERVER_PROBE=0` in `~/.config/nexus/config.env`.

### Automatic Compaction on Capacity Rejection
If a request exceeds the server's loaded context window (including llama.cpp `exceed_context_size_error`, LM Studio context overflow errors, vLLM `maximum context length`, or Ollama context length rejections), Nexus classifies the response as `CAPACITY_REJECTED`, compacts the conversation history once, and retries once at a reduced token budget. If the compacted retry is still rejected, the turn stops immediately with an actionable message naming `--context-limit` and the discovered window.

---

## 3. Timeouts, Custom TLS CAs, and Receipts

- **Startup reachability probe:** At session start (TUI and REPL), Nexus probes `GET /v1/models` with a 3-second timeout. If the endpoint is unreachable, Nexus displays a warning with the endpoint URL, cause, and fix instructions (`nexus doctor`, `~/.config/nexus/config.env`, `/connect`). If an endpoint has never succeeded during the session, recovery waits at most `NEXUS_FIRST_CONTACT_DEADLINE_MS` (default `120000` ms / 2 minutes).
- **Streaming timeouts:** Local endpoints use a 120-second first-byte timeout (`LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS=120000`) and a 120-second inter-chunk idle timeout (`LOCAL_LLM_IDLE_TIMEOUT_MS=120000`), with the whole-request total timeout disabled by default (`LOCAL_LLM_TIMEOUT_MS=0`) so long local generations are never cut off while tokens continue arriving.
- **Custom Certificate Authorities (`NODE_EXTRA_CA_CERTS`):** If your local server or LAN gateway uses HTTPS with a private CA, set `NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem` in `~/.config/nexus/config.env`. The `nexus` launcher exports `NODE_EXTRA_CA_CERTS` before Node starts, and `nexus doctor` verifies that the file exists and contains valid X.509 PEM certificates. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Local inference receipts:** Every local and cloud inference request writes a receipt to `<workspace>/.nexus/inference_receipts.jsonl` with `origin_class: "local"` or `"cloud"`. Set `NEXUS_RECEIPTS=0` in `~/.config/nexus/config.env` to opt out.
