# Nexus sidecar protocol

This is the reference for writing a client of the Nexus sidecar: the process that runs the agent and reports what it does. The Nexus terminal UI is one such client. The protocol is version 1.

The machine-readable form is [`protocol/sidecar-v1.schema.json`](protocol/sidecar-v1.schema.json), a JSON Schema generated from the types in `cli/src/protocol.ts`. This page says what the schema cannot: order, meaning and the rules of compatibility. Where the two disagree, the schema and the code are right and this page has a defect.

## What the protocol covers, and what it does not

A client starts the sidecar as a child process and talks to it over the child's standard input and output. That is the transport every client uses. A sidecar started with `--listen` additionally accepts other clients on a private unix socket (see Socket transport); nothing else, and no network listener, is offered.

Not part of this protocol today:

- No network transport: no TCP, HTTP or WebSocket listener exists. The one other transport is the opt-in unix socket (see Socket transport).
- No library entry point. The sidecar is a process, not an importable API (planned as PF-4).
- No Agent Client Protocol (ACP). This is Nexus's own protocol (ACP is planned as AC-1).

The sidecar projects the agent's state. It never asks the client to decide an outcome: whether a turn succeeded, whether a change is verified and whether a tool call is allowed are decided in the sidecar and reported. The one thing a client is asked for is a human's answer: yes or no to an `approval.request`, and a choice for a `checkpoint.choice.request`. An approval request is raised by the sidecar, when the agent's own approval policy wants a person to confirm a tool call. The client supplies the person's answer and nothing else: it cannot widen what the policy allows.

## Transport and framing

- The sidecar is the Node program `cli/dist/sidecar.js` (in an installed release, `lib/cli/dist/sidecar.js` under the Nexus home). Run it with `--help` for its options: endpoint, model, workspace, approval mode, `--resume`.
- The client writes commands to the sidecar's stdin and reads events from its stdout. Stdout carries protocol lines only. Stderr carries diagnostics for a log, in no fixed format.
- Each message is one JSON object on one line, UTF-8, ended by `\n` (newline-delimited JSON). A newline inside a string is escaped, as JSON requires. The sidecar ignores blank lines and accepts `\r\n`.
- Every message, in both directions, carries `v` (the protocol version, an integer) and `type` (a string that names the message).
- A string the sidecar sends is well-formed Unicode: a lone UTF-16 surrogate, which cutting a text can leave behind, is sent as U+FFFD.

### Sizes

The sidecar bounds the free-text fields of its events, counted in UTF-16 code units, and a text cut at its limit usually ends with `…[truncated N chars]`:

| Limit | Applies to |
|---|---|
| 8,000 (`MAX_TEXT_FIELD`) | most free text: `notice.text` and `detail`, `error.message`, `turn.result.heading` and `line`, `tool.start.subject`, `approval.request.subject` and `preview`, `steer.ack.message`, `slash.result.prompt`, `provider.auth.instructions`, the `message` of `provider.result` and `model.result` |
| 64,000 | `assistant.delta.text`, `steer.ack.text`, `tool.detail.args` and `output` |
| 256,000 | `tool.detail.diff` |
| 32,000 (`MAX_SLASH_OUTPUT`) | `slash.result.output` |
| 100,000 (`MAX_PASTE`) | `slash.result.composer` |
| 160 (`MAX_SUMMARY`) | `tool.end.summary` |

The Nexus terminal UI treats a stdout line longer than 1 MiB (1,048,576 bytes) as not a protocol event and drops it. The limits above bound the text fields they name; `turn.result` and `models.catalog` carry structured data with no stated cap, so this page does not promise that every event line stays below that size. A client may apply the same cap and should treat an over-long line as one dropped event, not as a broken connection.

The sidecar sets no limit on the length of a line it reads. It does limit some command fields: `initialize` accepts `client.name` and `client.version` of at most 100 characters and version bounds from 1 to 65,535, and `provider.connect` accepts an `endpoint` of at most 2,048 characters on a single line.

## Start-up and shut-down

1. The client starts the sidecar.
2. The sidecar sends `hello`, always first, and then `session.state`. After `--resume`, a `history` event (the restored conversation) comes between the two. `notice` events may follow, for example when no model provider answers.
3. The client may send `initialize` (see Negotiation). It does not have to.
4. The client sends commands; the sidecar sends events, some in answer to a command and some on its own.
5. The client sends `shutdown`, or closes the sidecar's stdin, which the sidecar treats as `shutdown`. The sidecar interrupts a running turn and exits with status 0.

Commands may be sent at any time after `hello`, including while a turn runs. The sidecar handles them in the order received.

## Socket transport

Experimental, and off by default. `sidecar.js --listen` binds a unix domain socket in addition to stdio. The process that started the sidecar keeps stdio and remains its owner: closing its stdin still shuts the sidecar down, and it keeps every command it has today. Other clients, as many as eight connections at once, attach to the same session through the socket. A sidecar started without `--listen` binds nothing and answers an `attach` line with `BAD_REQUEST`. `--listen` is refused (non-zero exit, nothing bound) when the session approves everything (`-y`, `--mode auto`) and when the socket directory lies inside the workspace, which the model can read.

**Where.** After `hello` and `session.state`, the sidecar prints one stdout line, `{"v":1,"type":"listening","socket":"<path>","descriptor":"<path>","pid":N}`. It is a launcher line, not an event of the schema, and it never carries the token. The socket and a descriptor file sit in a private directory: `$XDG_RUNTIME_DIR/nexus` when that variable is an absolute path to a directory only this user can use, otherwise `/tmp/nexus-sockets-<uid>`. The directory is created with mode 0700 and refused, never repaired, when it is a symlink, owned by another user or open to group or others. The socket is mode 0600. The descriptor is a 0600 file, `{"format":"nexus-socket/1","socket":"<path>","token":"<64 hex>","pid":N,"started_at":"<ISO time>"}`, and the token (32 random bytes) is new for every start. A client reads it as the hub does: a regular file owned by this user, mode 0600, at most 4 KiB. Node cannot read the peer's uid from a unix socket, so the 0700 directory and the 0600 socket are the access boundary, and the token is checked on top of it.

**Attach.** The first line of a connection must be `{"v":1,"type":"attach","id":"<id>","token":"<64 hex>","role":"control"|"observe"}` and must arrive within 2 seconds, in at most 4,096 bytes. At most 4 connections may be waiting to attach; another is told `BUSY` and closed. The sidecar compares the token in constant time and parses nothing else before it has matched. Every failure (a wrong, missing, malformed or differently cased token, a bad role, a first line that is not an attach, silence, a long line) gets the same single line, `{"v":1,"type":"error","code":"UNAUTHORIZED","message":"attach refused"}`, and the connection ends; the reason is never given. A success is answered `{"v":1,"type":"attached","id":"<id>","connection":"c<N>","role":"<role>"}`, followed by `hello` and the current `session.state` and, for the controller, the open `approval.request` again with its original id. Events from before the attach are not replayed. After that the stream is the same lines every client sees: every event the sidecar emits goes to stdio and to every attached socket client, and a response goes to all of them.

**Roles.**

- At most one `control` client. A second one is told `BUSY` ("another client controls this session") and closed; it may attach once the first has gone. When the controller disconnects, the turn and a pending approval carry on; the next controller is shown the approval and may answer it.
- Any number of `observe` clients. An observer may send `initialize` and nothing else: any other command gets `NOT_CONTROLLER` and is not run.
- The controller may send `initialize`, `prompt.submit`, `steer`, `cancel`, `approve` (once only), `deny`, `receipt` and `tool.detail`: what it takes to drive a turn, give a person's yes or no to one approval, and read results. That is the complete list.
- While the session approves everything, `prompt.submit` and `steer` get `NOT_PERMITTED` and are not run. This covers a session switched to auto, or given allow-always, from stdio after start: nothing would ask a person before the work ran. `cancel`, `deny`, `receipt` and `tool.detail` still work.
- Everything that could raise the session's authority or change Nexus's configuration is `NOT_PERMITTED` for every socket client and is not run: `approve` with `always: true` (allow-always, which would also switch the session to auto approval), every `slash` command (so no `/mode auto`, no `!` shell, no `/cd`), `answer` and `checkpoint.choice` (a decision about a requirement, or to persist sensitive content in a checkpoint, belongs to the owner on stdio), `models.list`, `model.select`, `provider.connect`, `provider.cancel`, `provider.local-cancel`, `provider.disconnect` and `shutdown`. The refusal is explicit, and the approval stays open for an answer of "once". Managed policy and the approval mode are as the process started with them; the socket changes neither.
- `initialize` is answered per connection by the socket layer and is never passed to the sidecar; a second one on a connection is `BAD_REQUEST`. Experimental features are not offered over the socket.

**Limits.** A line is at most 4 MiB after the attach; an oversized line gets `BAD_REQUEST`, and the third closes the connection. A client with more than 8 MiB waiting to be written is dropped, so a slow observer cannot stall the session.

**What the socket does not protect against.** Anything that runs as the same user and can read the descriptor can attach: the token keeps out a process that can reach the socket but not the descriptor, and a mixed-up path. It does not keep out unconfined code run as this user.

- Under `--sandbox` (bubblewrap) the sidecar hides the socket directory from every command and worker it runs, wherever `XDG_RUNTIME_DIR` points (`/run/user/<uid>`, `/var/tmp`, under `$HOME`). Docker mounts only the workspace. The sidecar refuses to start `--listen` with the directory inside the workspace.
- Without a sandbox, which is the default, nothing is hidden. A command that runs unsandboxed, in auto mode or approved in review mode, acts with your rights: it can read the descriptor and attach as controller, or as an observer when a controller is attached. The same holds for an unsandboxed MCP server or plugin, and for any other process of yours. Use `--sandbox` for untrusted work.
- Root can always attach.

**Cleanup.** On shutdown, SIGTERM and SIGINT the sidecar removes its socket and descriptor. At start it removes any `s-<16 hex>.sock` of this user that no process listens on; it never removes anything else, never replaces a socket a live process listens on, and refuses a symlink or a file at its path.

## Versioning

- `PROTOCOL_VERSION` (1) is the version the sidecar speaks by default: the `v` of every event, and the `protocol` field of `hello`.
- The sidecar can speak an inclusive range of versions, `PROTOCOL_MIN` to `PROTOCOL_MAX`, announced in `hello` as `protocol_min` and `protocol_max`. Today the range is 1 to 1.
- The sidecar accepts a command whose `v` is an integer inside that range. Any other `v` is refused with `error` / `BAD_REQUEST` ("unsupported protocol version").
- Within one version, changes are additive: a new optional field on an existing message, a new event type, a new command, a new error code, a new capability name. An additive change never removes a field, never changes the type or meaning of an existing field, and never makes an optional field required. A peer written before the change keeps working because of the compatibility rules below.
- Anything else is a breaking change and needs a new protocol version: `PROTOCOL_VERSION` is raised, the range `PROTOCOL_MIN` to `PROTOCOL_MAX` says which versions the sidecar still speaks, and a new schema file `protocol/sidecar-v<N>.schema.json` is published.
- Every change to the protocol types is recorded. [`protocol/VERSIONS.json`](protocol/VERSIONS.json) is a ledger whose newest entry must carry the SHA-256 of the checked-in schema and the current version, with a note that states the decision (additive, same version; or a new version). CI fails when a type changes and the schema and ledger do not. [`protocol/README.md`](protocol/README.md) describes the procedure.

## Negotiation

`hello` tells a client what it is talking to:

- `protocol`: the default version.
- `protocol_min`, `protocol_max`: the range. A sidecar older than negotiation sends neither; it speaks exactly `protocol`.
- `capabilities`: the stable features this sidecar supports (see Capabilities). Absent from an older sidecar.
- `experimental`: experimental features this sidecar offers. Each is off until the client asks. No experimental feature exists today, so the list is empty.

A client that can work with the announced range may simply start sending commands. `initialize` is optional: a client that never sends it gets protocol 1 as first published.

`initialize` carries `client` (`name` and `version`, both non-empty strings) and, optionally, `protocol_min` and `protocol_max` (the versions the client can speak) and `experimental`. The rules:

- The two range bounds go together: one without the other is `BAD_REQUEST`, and so is a minimum above the maximum. With no range, the client is taken to speak exactly the `v` of the message.
- When the ranges share a version, the sidecar answers `initialized` with `protocol` set to the highest shared version, the `capabilities` in force, and `experimental`: the experimental features now enabled, which is empty unless the client sent `experimental: true`.
- When they share none, the sidecar answers `error` with code `UNSUPPORTED_PROTOCOL`. From then on it refuses every command except `initialize` and `shutdown` with the same code, until a later `initialize` succeeds.
- Only a successful `initialize` uses up the connection's negotiation. After `initialized`, another `initialize` is `BAD_REQUEST` and changes nothing. One refused as malformed or with `UNSUPPORTED_PROTOCOL` settled nothing, so the client may send another.
- The sidecar speaks its default `protocol` until it has answered `initialized`. With a range of 1 to 1 the negotiated version is always 1.
- `initialize` may be sent at any time, including while a turn runs; it does not disturb the turn.
- A sidecar older than negotiation answers `initialize` with `BAD_REQUEST` (unknown message type). The client then carries on without negotiation.
- An experimental feature used on a connection that did not enable it is refused with `EXPERIMENTAL_DISABLED`.

## Commands

Client to sidecar. A command that expects an answer carries `id`, a non-empty string the client chooses; the answering event, or the `error`, carries the same `id`. All fields of each command are in the schema under `$defs.SidecarCommand`.

| Type | Required fields | Meaning |
|---|---|---|
| `initialize` | `client`, `id` | Negotiation, which a client may skip: who the client is, the version range it speaks, and whether it wants experimental features. Answered with `initialized`, or `error` (`UNSUPPORTED_PROTOCOL`, `BAD_REQUEST`). Optional: `protocol_min`, `protocol_max`, `experimental`. |
| `prompt.submit` | `id`, `text` | Start a turn with `text`. `id` becomes the `turn_id` of every event of that turn. Refused with `BUSY` while a turn or command runs, and with `NO_PROVIDER` when no model is reachable. |
| `steer` | `id`, `text` | Guidance for the work in progress. Answered with `steer.ack`; when nothing is running it starts a turn. |
| `cancel` | none | Interrupt the running turn or command. No answer of its own: the turn ends with its `turn.result`. With nothing running it does nothing. |
| `approve` | `always`, `id` | Yes to the pending `approval.request` with this `id`. `always: true` also stops asking for the rest of the session. `NO_PENDING_APPROVAL` when no such request is open. |
| `deny` | `id` | No to the pending `approval.request` with this `id`: the call does not run. `NO_PENDING_APPROVAL` when no such request is open. |
| `answer` | `id`, `option`, `question` | The operator's decision (`option`: `approve` or `decline`) on the question a turn ended with (`question`: the 12-hex-character id in `turn.needsInput`). Recorded now, applied when the next turn reaches that decision; acknowledged with a `notice`. |
| `checkpoint.choice` | `choice`, `id` | The answer to the pending `checkpoint.choice.request` with this `id`. `NOT_FOUND` when none is open; `BAD_REQUEST` when the choice is not offered. |
| `slash` | `args`, `command`, `id` | Run a command of the catalogue `hello.commands` (`command` is its name, with or without the leading slash; `args` as typed). Answered with `slash.result`. |
| `tool.detail` | `evidence`, `id` | Ask for the full record of the tool call whose `tool.start` carried this `evidence`. Answered with the `tool.detail` event, or `NOT_FOUND`. |
| `receipt` | `id` | Ask for the evidence receipt of the last turn. Answered with the `receipt` event. |
| `models.list` | `id` | Ask for providers and models. Answered with `models.catalog` (`BUSY` in read-only mode). |
| `model.select` | `id`, `model`, `provider` | Switch model between turns. Answered with `model.result` (`BUSY` in read-only mode). |
| `provider.connect` | `id`, `method`, `provider` | Connect a provider by `method`. Answered with `provider.result`, after `provider.auth` when a sign-in needs the operator. Optional: `key` (for the API-key method only; never echoed), `endpoint`. |
| `provider.cancel` | `id` | Stop the `provider.connect` or `models.list` request with this `id`. No answer of its own. |
| `provider.local-cancel` | `id` | Discard a completed local-endpoint setup made by the `provider.connect` with this `id`. No answer of its own. |
| `provider.disconnect` | `id`, `provider` | Remove a provider's connection. Answered with `provider.result`. |
| `shutdown` | none | End the session: the running turn is interrupted, the sidecar exits. No answer. |

The schema states the fields and their JSON types. The sidecar also checks values the schema does not describe: `prompt.submit` and `steer` need text that is not blank, and `answer.question` must be 12 lower-case hexadecimal characters. A command that fails such a check is refused with `BAD_REQUEST`.

## Events

Sidecar to client. All fields of each event are in the schema under `$defs.SidecarEvent`.

| Type | Required fields | Meaning |
|---|---|---|
| `hello` | `commands`, `pid`, `protocol` | First line of every connection: the default protocol version, the sidecar's pid and the slash-command catalogue. Optional (absent from sidecars older than negotiation): `protocol_min`, `protocol_max`, `capabilities`, `experimental`. |
| `initialized` | `capabilities`, `experimental`, `id`, `protocol` | Answer to `initialize`: the negotiated version, the stable capabilities, and the experimental features now enabled. |
| `session.state` | `busy`, `git`, `mode`, `model`, `workspace`, `workspace_name` | The session as the client should show it: workspace, model, approval mode, git branch and dirty count (or `null`), and whether work is running. Sent at start-up and again when the state changes, for example when a turn starts and when it ends. |
| `assistant.delta` | `text`, `turn_id` | A piece of the model's text for the running turn. Concatenate in order. |
| `stream.stall` | `silent_secs`, `stalled`, `turn_id` | The provider's stream has been silent for `silent_secs` (`stalled: true`), or has resumed (`false`). |
| `activity` | `phase`, `segment`, `step`, `turn_id` | What the running turn is doing now (`phase`, step and segment counters); sent on every phase change. |
| `file.diff` | `added`, `call_id`, `diff_lines`, `evidence`, `hunks`, `kind`, `path`, `preview`, `removed`, `total_lines`, `truncated`, `turn_id` | A tool changed a file: a bounded preview of that change. `evidence` names the full record. |
| `steer.ack` | `id`, `message`, `status` | What became of a `steer`: `status` is one of `held`, `queued`, `applied`, `deferred`, `cancelled`, `rejected`, `duplicate`. `text` returns the message when it was not applied. |
| `tool.start` | `call_id`, `evidence`, `subject`, `tool`, `turn_id` | A tool call began. `evidence` is the handle for `tool.detail`. |
| `tool.end` | `call_id`, `evidence`, `lines`, `success`, `summary`, `tool`, `turn_id` | The tool call ended: success, a one-line summary and the count of output lines. Optional: `preview`, `exit_code`, `duration_ms`, `timed_out`, `denied`. |
| `approval.request` | `id`, `preview`, `review`, `subject`, `tool`, `turn_id` | A tool call waits for the operator's yes or no. Answer with `approve` or `deny` and this `id`. `review` describes what is being approved. |
| `checkpoint.choice.request` | `id`, `message`, `turn_id` | The turn's checkpoint needs the operator's choice; `message` says what happened and what the choices are. Answer with `checkpoint.choice` and this `id`. |
| `turn.result` | `heading`, `line`, `model_summary`, `saved`, `turn`, `turn_id` | The turn ended. `turn` is the full result record (execution, outcome, verification, ...); `heading` and `line` are its one-line forms; `saved` is false when the session record could not be written. |
| `slash.result` | `command`, `id`, `output`, `success` | Outcome of a `slash` command. Optional: `format`, `composer`, `clipboard`, `prompt` (the command started a turn whose events follow under the same id). |
| `notice` | `text` | A message for the operator. A later notice with the same `key` replaces the earlier one. Optional: `key`, `detail`. |
| `history` | `messages`, `session`, `total` | After a resume: the recent conversation, oldest first; `total` counts all of it. |
| `tool.detail` | `args`, `duration_ms`, `evidence`, `id`, `output`, `status`, `subject`, `tool` | Answer to the `tool.detail` command: arguments, output, status and duration of one tool call. Optional: `diff`, `diff_chars`, `diff_path`. |
| `receipt` | `id`, `sections` | Answer to the `receipt` command: sections of labelled rows. |
| `error` | `code`, `message` | A command was refused or failed. `code` is one of the error codes below; `id` is the command's id when it had one. |
| `models.catalog` | `current`, `id`, `models`, `providers`, `recent` | Answer to `models.list`: providers (with where each credential comes from, never the credential), models, the current model and recent ones. |
| `provider.auth` | `id`, `instructions`, `provider`, `url` | A sign-in needs the operator: open `url`, and type `user_code` when present. |
| `provider.result` | `id`, `message`, `provider`, `success` | Outcome of `provider.connect` or `provider.disconnect`. |
| `model.result` | `id`, `message`, `success` | Outcome of `model.select`. |

A turn started by `prompt.submit` with id `t1` looks like this on the wire: `session.state` with `busy: true`; then `activity`, `tool.start`, `tool.end`, `file.diff`, `assistant.delta` and `approval.request` events carrying `turn_id: "t1"` as the work proceeds; then one `turn.result`; then `session.state` with `busy: false`.

## Error codes

The `code` of an `error` event:

| Code | Meaning |
|---|---|
| `BAD_REQUEST` | The line is not a command the sidecar accepts: not JSON, not an object, a `v` outside the range, an unknown `type`, a missing or invalid field, or a second `initialize`. |
| `BUSY` | The command cannot run now: a turn or command is running, the sidecar is shutting down, or the session is read-only. |
| `NO_PENDING_APPROVAL` | `approve` or `deny` named an approval that is not open. |
| `NOT_FOUND` | The thing asked for does not exist: a tool-call record, or a pending checkpoint choice. |
| `INTERNAL` | The sidecar failed while handling the command. The message is redacted. |
| `NO_PROVIDER` | No model provider is reachable, so the prompt was not sent. |
| `UNSUPPORTED_PROTOCOL` | `initialize` named a range that shares no version with the sidecar's, or a command arrived after such an `initialize`. |
| `EXPERIMENTAL_DISABLED` | An experimental feature was used on a connection that did not enable it. |
| `UNAUTHORIZED` | Socket transport only: the attach was refused. The message never says why (token, role, order or timing); the connection then ends. |
| `NOT_CONTROLLER` | Socket transport only: an observer sent a command other than `initialize`. |
| `NOT_PERMITTED` | Socket transport only: the controller sent a command a socket client may not send (allow-always, a slash command, `answer`, `checkpoint.choice`, a provider or model change, `shutdown`), or `prompt.submit` or `steer` while the session approves everything. |

## Capabilities

Every sidecar handles `prompt.submit`, `cancel`, `approve`, `deny` and `shutdown`. Each name in `hello.capabilities` is the `type` of a further command this sidecar accepts, so a client checks that the name is present before it sends that command. Names are sorted. Within a protocol version a name is never removed or given a new meaning.

| Capability | The sidecar accepts |
|---|---|
| `answer` | `answer` |
| `checkpoint.choice` | `checkpoint.choice`, the reply to `checkpoint.choice.request` |
| `model.select` | `model.select`, answered with `model.result` |
| `models.list` | `models.list`, answered with `models.catalog` |
| `provider.connect` | `provider.connect`, with `provider.cancel` and `provider.local-cancel` for the same request |
| `provider.disconnect` | `provider.disconnect` |
| `receipt` | `receipt` |
| `slash` | `slash`, for the commands listed in `hello.commands` |
| `steer` | `steer`, answered with `steer.ack` |
| `tool.detail` | `tool.detail` |

## Compatibility

- Unknown fields are ignored in both directions. The sidecar reads the fields of a command that it knows and drops the rest. A client must ignore fields of an event that it does not know: a newer sidecar may add optional ones.
- A client should ignore an event whose `type` it does not know. A newer sidecar may send new event types.
- The sidecar refuses a command whose `type` it does not know with `error` / `BAD_REQUEST` ("unknown message type"), carrying the command's `id` when it has one, and carries on. A client can therefore try a newer command against an older sidecar, though checking `hello.capabilities` first is better.
- A line that is not JSON, or not a JSON object, is refused with `BAD_REQUEST` without an `id`. The sidecar does not close the connection over a bad line.
- An optional field may be absent. A client must not rely on a field the schema does not list under `required`.
- A valid message under the schema is necessary, not sufficient: see the value checks under Commands.

## A session

A real session, replayed by the test suite from `cli/test/fixtures/wire/turn.json`. `C:` is a line the client wrote, `S:` a line the sidecar wrote. Values that differ from run to run are shown as the recording holds them: `<any:number>` and `<any:array>` stand for any value of that type (`commands` is the slash catalogue, some fifty entries), `<id:NAME>` for an id that repeats, `<workspace>` for the workspace path.

<!-- example: turn -->
```text
S: {"v":1,"type":"hello","protocol":1,"pid":"<any:number>","commands":"<any:array>","protocol_min":1,"protocol_max":1,"capabilities":["answer","checkpoint.choice","model.select","models.list","provider.connect","provider.disconnect","receipt","slash","steer","tool.detail"],"experimental":[]}
S: {"v":1,"type":"session.state","workspace":"<workspace>","workspace_name":"<workspace-name>","model":"m","mode":"auto","git":{"branch":"main","dirty":0},"busy":false,"session":"<id:session>","read_only":false,"context_tokens":"<any:number>","context_limit":65536,"endpoint_kind":"local","posture":{"mode":"auto","sandbox":"off","trusted":false}}
C: {"v":1,"type":"prompt.submit","id":"t1","text":"what is here?"}
S: {"v":1,"type":"session.state","workspace":"<workspace>","workspace_name":"<workspace-name>","model":"m","mode":"auto","git":{"branch":"main","dirty":0},"busy":true,"session":"<id:session>","read_only":false,"context_tokens":"<any:number>","context_limit":65536,"endpoint_kind":"local","posture":{"mode":"auto","sandbox":"off","trusted":false}}
S: {"v":1,"type":"activity","turn_id":"t1","phase":"inference","step":1,"segment":1,"max_steps":6}
S: {"v":1,"type":"tool.start","turn_id":"t1","call_id":"call_1","tool":"list_dir","subject":".","evidence":"e1"}
S: {"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":1,"segment":1,"max_steps":6,"tool":"list_dir","subject":"."}
S: {"v":1,"type":"tool.end","turn_id":"t1","call_id":"call_1","tool":"list_dir","success":true,"evidence":"e1","summary":"{","lines":11}
S: {"v":1,"type":"activity","turn_id":"t1","phase":"inference","step":2,"segment":1,"max_steps":6}
S: {"v":1,"type":"assistant.delta","turn_id":"t1","text":"There is one file."}
S: {"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - NO CHANGES TO VERIFY","line":"execution=COMPLETED outcome=NOT_REQUIRED modelStop=FINAL_TEXT","turn":{"acceptance":"NOT_REQUESTED","modelStop":"FINAL_TEXT","finalOutputComplete":true,"verification":null,"interruption":null,"inferenceFailure":null,"steps":{"used":2,"max":6,"limitReached":false},"unverifiedChangesPending":false,"finishedAt":"<id:finished>","tokenAccounting":{"contextLimit":65536,"contextSource":"client_default","outputAllowance":8192,"outputSource":"client_default","toolHeadroomPolicy":4096,"discovery":"unsupported","tokenCounting":"unsupported","lastRequest":{"step":2,"promptTokens":"<any:number>","source":"client_estimate","clientEstimate":"<any:number>","uncertainty":"the connection advertises no request counting"}},"toolCallSyntax":{"native":1,"trailing":0,"structural":0,"invalid":0,"schema":0},"turnEvidence":{"workspaceChanged":"no","carriedChanges":false,"denied":0,"verifierRuns":[]},"execution":"COMPLETED","outcome":"NOT_REQUIRED"},"model_summary":null,"saved":true}
S: {"v":1,"type":"session.state","workspace":"<workspace>","workspace_name":"<workspace-name>","model":"m","mode":"auto","git":{"branch":"main","dirty":0},"busy":false,"session":"<id:session>","read_only":false,"context_tokens":"<any:number>","context_limit":65536,"endpoint_kind":"local","posture":{"mode":"auto","sandbox":"off","trusted":false}}
```

After this, the same recording sends `tool.detail` and `receipt` and gets the events of those names back.

## Conformance

Three checks keep this protocol and its two implementations in step. All run in CI.

- Schema: `cli/test/protocol_schema.test.ts` fails when `cli/src/protocol.ts` changes and the schema and ledger do not.
- Parity: `cli/scripts/gen_protocol_samples.mjs` generates a minimal and a full sample of every message from the schema. The Rust client must parse every event sample as its own variant and account for every field, and every command the Rust client can serialize must validate against the schema and be accepted by the sidecar's parser (`cli/test/protocol_parity.test.ts`, and the tests in `core/src/bin/nexus_tui/protocol.rs`).
- Wire fixtures: `cli/test/protocol_wire.test.ts` replays the recorded sessions in `cli/test/fixtures/wire/` against the real sidecar with a scripted model, event for event. `cli/test/helpers/wire_fixture.ts` describes the recording format and how to record one.

A third-party client can use the same material: validate what it sends against `$defs.SidecarCommand`, and replay the events of a recording into its own event handling.
