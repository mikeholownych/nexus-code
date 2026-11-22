# `nexus run --output stream-json`

One JSON object per line (NDJSON) on **stdout**, and nothing else there: human text, diagnostics and the cloud-usage
summary go to stderr or are left out. Use it to follow a run live from a script or another tool.

```bash
nexus run -y --output stream-json "fix the failing test" | jq -c 'select(.type=="tool.end")'
```

`--output` takes `text` (default), `json` (identical to `--json`: one document at the end) or `stream-json`.
`--json` cannot be combined with `--output stream-json`; an unknown format exits 2 with a usage error.

## Envelope

Every event has:

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. Changes only when an existing field changes meaning or goes away; new event types and new fields do not bump it, so readers must ignore what they do not know. |
| `seq` | 1, 2, 3, … within the run, no gaps. |
| `ts` | ISO 8601 UTC time the event was written. |
| `type` | One of the types below. |

Newlines (and U+2028/U+2029) inside strings are escaped, so one event is always exactly one line.

## Events

| `type` | Fields | When |
|---|---|---|
| `start` | `model`, `provider` (when a cloud provider is selected) | Once, before the first model request. |
| `assistant.delta` | `text` | A piece of the model's reply as it streams. Raw model text, as in the interactive views. |
| `tool.start` | `call_id`, `tool` | A tool call begins. Arguments are not streamed. |
| `tool.end` | `call_id`, `tool`, `success`, `output_chars`, `error`?, `denied`? | The call ends. `error` is redacted and at most 500 characters; `denied` is `true` when the operator's policy refused the call. The output itself is in the evidence of the final result. |
| `security.injection_suspected` | `tool`, `step`, `signals` | A tool result was labelled and fenced as suspected prompt injection (CS-7). `signals` are rule ids; the content is never in the event. |
| `notice` | `text` | Something the operator should know (redacted, at most 500 characters). |
| `result` | The same document `--json` prints, starting with its `schema_version` (see "`nexus run --json`" in the user manual and `docs/protocol/run-result-v1.schema.json`) (`taskId`, `success`, `status`, `output`, `plan`, `validationReceipts`, `tokenStats`, `exitCode`, …), plus `cloudUsage` when a cloud provider was used | Once, last, when the task finished. |
| `error` | `taskId`, `message` (redacted) | Once, last, instead of `result`, when the run failed before producing one. |

The process exit code is the same as for `--json`; `result.exitCode` repeats it. A run that is killed mid-way ends
without a `result` or `error` line: treat a missing final event as a failure.

## What is not streamed

Tool arguments and outputs, file contents, and the prompt are not in the stream, so a consumer that stores it does not
store them. Assistant text is passed through as the model wrote it. Fields that carry free text from tools or
diagnostics are redacted with the same rules as the rest of Nexus's output.
