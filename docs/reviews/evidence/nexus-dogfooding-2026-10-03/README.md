# Evidence harness for NEXUS_DOGFOODING_READINESS_REVIEW_2026-10-03

Non-product, throwaway probes used to reproduce client-side behaviour deterministically.

- `fakegw.mjs <port> <scenario> <logfile>` — fake OpenAI-compatible gateway. Scenarios: `http500`, `loop`, `echo`,
  `slow`, `slowloop`, `truncstream`, `midstreamerror`, `noverify`, `falseclear`. It logs every request
  (message count, bytes, tool count, X-Task-Class, X-Request-ID).
- `probe.sh`, `probe_dirty.sh`, `probe_clean.sh` — one-shot `nexus run` probes (hard-coded scratchpad path `S`; edit before reuse).
- `repl_probe.py <scenario>` — pexpect pty driver for the interactive REPL (`multi`, `http500_recover`, `ctrlc_idle`,
  `ctrlc_run`, `ctrlc_slowloop`, `typeahead`, `tui`, `crash_image`, `crash_history_run`, `crash_compact`).

Isolation rules used: `HOME` pointed at a scratch dir (no real ~/.nexus state, no real config), the workspace is a throwaway git repo,
the endpoint is passed with `-e` (NOTE: a copied `~/.config/nexus/config.env` overrides the `LOCAL_LLM_ENDPOINT` env var — finding B-10).
One bounded `--read-only` run was made against the real gateway (`engineering/b0`); nothing else touched it.
Paths inside the scripts are for the original scratchpad and will need editing.
