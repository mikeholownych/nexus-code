# Scheduled gateway conformance (MQ-4)

`scripts/gateway_conformance.mjs` runs the tool-call matrix (`eval/tool_grammar_matrix.mjs`, unmodified) against the gateway aliases in a prepared private config and alerts when an alias falls below the 99.5% native-valid bar or drops from the previous result. It is for a **local** scheduler: the gateway (10.0.8.5) is not reachable from GitHub-hosted runners.

```sh
node scripts/gateway_conformance.mjs --config /abs/private-config.json \
  --baseline /abs/previous-result.json --alert-cmd 'mail -s "gateway conformance" me@example.com'
```

- **Config:** the same private config the matrix runner takes (see `docs/v1.1.4/G1.1-4-LIVE-MATRIX.md`: archive, install root, candidate checkout, pinned digests, one provider entry per alias, `apiKeyEnv` naming an environment variable). The key is read from the environment of the run, never from the config. The config's `outputPath` is where the result is written; the job removes any previous file there before it runs, so an old passing result is never judged.
- **Claim:** the job takes the `GATEWAY` claim (`$(git rev-parse --git-common-dir)/nexus-claims/GATEWAY`, `NEXUS_CLAIMS_DIR` overrides) without waiting. If a human or another agent holds it, the run is **skipped** (exit 75, no alert). The claim is released, and one line logged, on every exit path.
- **Judgement:** per alias, native-valid calls divided by attempts, against `--min-ratio` (default 0.995) and against the baseline (`--max-drop`, default 0.01). It does not use the runner's `passed` flag, because an alias served with reasoning off cannot meet the runner's hybrid-reasoning check and would alert on every run.
- **Alert:** `conformance-alert.json` is written next to the result, and `--alert-cmd` (run with `sh -c`, the JSON on stdin) is executed. A failing alert command is reported on stderr and does not hide the failure. A run that produces no result alerts as `run-failed`.
- **Exit codes:** 0 conformant, 1 not conformant or run failed (alert raised), 2 usage or setup error, 75 skipped (claim held).

## Scheduling it

Nothing is installed by this repository. A weekly user timer (adapt the paths; put it under Ansible if you manage the host that way):

```ini
# ~/.config/systemd/user/nexus-gateway-conformance.service
[Service]
Type=oneshot
Environment=NEXUS_GATEWAY_KEY_FILE=%h/.config/nexus/gateway.env
EnvironmentFile=%h/.config/nexus/gateway.env
ExecStart=/usr/bin/node /abs/nexus-code/scripts/gateway_conformance.mjs --config /abs/conformance-config.json --baseline /abs/last-good-result.json --alert-cmd /abs/notify.sh
SuccessExitStatus=75

# ~/.config/systemd/user/nexus-gateway-conformance.timer
[Timer]
OnCalendar=Sun 03:00
Persistent=true
[Install]
WantedBy=timers.target
```

`SuccessExitStatus=75` keeps a skipped run (claim held) from showing as a failed unit.

## Live result

The first live run against the published v1.2.1 archive completed on 2026-11-18 and **did not meet the 99.5% native-valid bar**. `engineering/deep` returned 177/200 (88.5%) native-valid calls and `engineering/lead-reasoning` returned 155/200 (77.5%). The raw result and per-tool breakdown are recorded in [`docs/evidence/v1.2.1/MQ-4-first-live-run.md`](evidence/v1.2.1/MQ-4-first-live-run.md); the JSON result is retained unchanged beside it. This is a failed conformance observation, not a passing qualification. The scheduler role was not applied after this result.

## What is and is not validated

The claim protocol, the judgement, the alert path (forced failure, a failing alert command, a runner that produces nothing) and the stale-result rule are tested end to end through the script with a fake matrix runner (`cli/test/gateway_conformance.test.ts`, each behaviour mutation-checked). A live run has now been performed once; it failed the configured bar. One run does not establish repeatability or isolate gateway load, worker changes, or other causes.
