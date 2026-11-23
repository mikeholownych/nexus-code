# Telemetry: what Nexus records about a session, and where it goes

Nexus Code sends no telemetry. It has no analytics, crash-report or trace exporter, and nothing described on this page leaves the machine. The only requests Nexus makes are the ones you configure: your model provider, the MCP servers you add, and web tools when the agent uses them.

What Nexus does keep is a **local trace file** per session: timing records of turns, tool calls, model requests and context compactions, written to your home directory so that you can see where a session spent its time. This page says what is in that file, how to turn it off, and how long it is kept.

## Where it is

```
~/.local/share/nexus/traces/<session id>/trace.jsonl
```

One JSON object per line, in the OTLP/JSON file-exporter shape (`resourceSpans` → `scopeSpans` → `spans`), so standard OpenTelemetry tools can read it if you choose to load it into one. The directories are created with mode `0700` and the file with `0600`. Nexus refuses to write through a symbolic link or to a file with more than one name.

## What is in it

Each line is one finished span: a name, a start and end time, a random trace id and span id, a parent span id, a status (ok, error, unset) and the attributes below. The resource carries `service.name` (`nexus-code`) and the scope carries the Nexus version.

| Span | Attributes |
|---|---|
| `nexus.agent.turn` (one per turn) | `nexus.task.id`, `nexus.turn.execution`, `nexus.turn.outcome` |
| `nexus.agent.tool` (one per tool call) | `nexus.tool.name`, `nexus.tool.actor` (agent or subagent), `nexus.tool.step`, `nexus.tool.success`, `nexus.tool.duration_ms` |
| model request, named `<operation> <model>` | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` |
| `nexus.context.compaction` | `nexus.compaction.trigger`, `nexus.compaction.step`, `nexus.compaction.before_tokens`, `nexus.compaction.after_tokens`, `nexus.compaction.pressure_only`, `nexus.compaction.archived_messages`, `nexus.compaction.durable`, `nexus.compaction.committed` |

What is **not** in it: prompts, model replies, tool arguments, tool output, file contents, file paths, commands, environment variables or credentials. The writer refuses the attribute names that would carry message content or the superseded GenAI names (`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`). Every span name and attribute value also passes through the same secret classifier that protects outbound requests, and a classified value is replaced irreversibly before the line is written.

A test (`cli/test/trace_transparency.test.ts`) fails when the client starts writing a span or attribute name that this table does not list.

## Turning it off

```sh
export NEXUS_TRACES=off      # also accepted: 0, false, no
```

With traces off, Nexus creates no trace file and no trace directory. Files written earlier stay until the retention period removes them or you delete them. A trace that cannot be written (a read-only home, a full disk) never interrupts a session either way.

## How long it is kept

Trace files older than **30 days** are removed. The check runs once when a session starts tracing; it removes a session's `trace.jsonl` when that file was last written more than the period ago, and the session's directory if that leaves it empty.

```sh
export NEXUS_TRACE_RETENTION_DAYS=7     # keep one week
export NEXUS_TRACE_RETENTION_DAYS=0     # keep indefinitely
```

A value that is not a whole number of days falls back to 30. Retention only ever removes a regular trace file inside a real session directory under `traces/`; it follows no links and touches nothing else. Before v1.3.0 trace files were kept indefinitely, so the first session after upgrading removes traces older than 30 days unless you set the variable to `0`.

To delete every trace now: `rm -r ~/.local/share/nexus/traces`.

## Other files Nexus keeps locally

These are session data, not telemetry, and have their own documentation: saved sessions and their exports, the flight recorder, verification attempts and evidence. They can contain your prompts and tool output, redacted by the same classifier; they also stay on the machine unless you export and share them.

## How this is checked

- The trace writer imports only file, path, crypto and OS modules; a test asserts that list.
- A test writes traces with the socket, HTTP, DNS, datagram and `fetch` entry points replaced by functions that fail, and asserts that none was called.
- Tests cover the off switch (nothing created) and retention (old files removed; links, hard links, foreign files and unknown directory names left alone).

This settles plan unit GV-4 and the earlier PC-5.
