# Embedding Nexus in another program

Nexus has a library entry point for a Node program that wants to run tasks without a terminal: `cli/src/lib.ts`, built to `cli/dist/lib.js`. It starts the Nexus sidecar as a child process and talks to it in the [sidecar protocol](PROTOCOL.md). A runnable example is in [`examples/embed/`](../examples/embed/).

The library API version is `NEXUS_LIB_API_VERSION` (1). Its runtime and TypeScript type exports are recorded in [`protocol/LIB_API_VERSIONS.json`](protocol/LIB_API_VERSIONS.json), and a test fails when either list differs.

## Importing it

The package (`local-code-harness`) is not published to npm (decision D13 of the v1.3.0 plan), and `npm publish` is made to fail. Import the entry point by path:

```js
// An installed release: NEXUS_HOME is the directory that holds bin/nexus.
const nexus = await import(`${process.env.NEXUS_HOME}/lib/cli/dist/lib.js`);
// A checkout, after `npm --prefix cli run build`:
const nexus = await import("/path/to/nexus-code/cli/dist/lib.js");
```

A `node_modules/local-code-harness` symlink to a checkout's `cli/` directory also works; `import "local-code-harness"` then resolves through the package's `exports`, which names this entry point and nothing else. Type declarations are in `dist/types/lib.d.ts`. The entry point is an ES module; there is no CommonJS build.

Importing the entry point does nothing. It parses no command line, never calls `process.exit`, writes nothing to stdout or stderr, reads neither `HOME` nor the environment, and leaves no listener or timer behind. Its only runtime dependencies are Node built-ins. `cli/test/lib_entry.test.ts` checks each of these.

## A minimal embedding

```js
const { spawnSidecar } = await import(process.env.NEXUS_LIB);

const client = await spawnSidecar({
  workspace: "/path/to/a/git/repository",
  authoritativeVerifier: "node --test",
  deliverableFiles: ["add.js"],
});
try {
  const result = await client.prompt("Fix add() in add.js so that the test passes.", {
    onApproval: (request) => {
      if (["run_command", "write_file", "edit_file"].includes(request.tool)) return "approve";
      if (request.tool === "verifier" && request.review.kind === "verifier" && request.review.command === "node --test" && request.review.detail === "configured") return "approve";
      return "deny";
    },
  });
  console.log(result.turn.outcome); // "VERIFIED" only when the verifier passed on the declared deliverable
} finally {
  await client.shutdown();
}
```

## API

`spawnSidecar(options)` starts a sidecar and resolves with a `SidecarClient` once the sidecar has sent `hello`. It rejects with a `SidecarClientError` (`code` `SPAWN_FAILED`, `CHILD_EXITED` or `TIMEOUT`, and a `stderrTail` property) when the sidecar does not start.

| Option | Meaning |
|---|---|
| `workspace` | The directory to work in. Required. |
| `endpoint`, `model` | The inference endpoint and model. Without them the sidecar uses its own settings, as `nexus` does. |
| `mode` | `"review"` (the default) or `"read-only"`. |
| `authoritativeVerifier` | A trusted command that must pass before a task may complete. |
| `deliverableFiles` | Workspace-relative product files the task is meant to change. |
| `sandbox` | The value of the sidecar's `--sandbox` option. |
| `extraArgs` | Further sidecar options, appended unchanged (`node cli/dist/sidecar.js --help` lists them). |
| `env` | The child's environment. Default: the embedding process's. |
| `node`, `sidecarScript` | The Node binary and the sidecar script. Defaults: the running Node, and the `sidecar.js` next to `lib.js`. |
| `signal` | An `AbortSignal` that stops the child. |
| `readyTimeoutMs` | How long to wait for `hello`. Default 30 000. |

`SidecarClient`:

| Member | Meaning |
|---|---|
| `hello` | The sidecar's `hello` event: protocol range, capabilities, process id. |
| `initialize({ name, version })` | Optional protocol negotiation. Resolves with the `initialized` event. |
| `prompt(text, { onApproval, signal })` | Runs one turn and resolves with its `turn.result` event, whatever the outcome. One turn at a time: a second call while one runs rejects with code `BUSY`. Aborting `signal` cancels the turn. |
| `receipt()` | The evidence receipt of the last turn. |
| `cancel()` | Cancels the running turn. |
| `on(name, listener)`, `off(name, listener)` | `"event"`: every protocol event. `"protocol-error"`: a line that was not a protocol event (it is dropped). `"exit"`: the child exited. |
| `stderrTail` | The last 64 KiB of the sidecar's stderr. The client never prints it. |
| `pid` | The child's process id. |
| `shutdown({ graceMs })` | Stops the sidecar and resolves with `{ code, signal }`. |

A promise rejects with a `SidecarClientError` whose `code` is the sidecar's error code (`NO_PROVIDER`, `BUSY`, …) or one of the client's own: `CHILD_EXITED` (the sidecar exited or closed its output before it answered), `CLOSED` (called after exit or shutdown, or when the sidecar input stream is closed), `ABORTED`.

The client reads at most 16 MiB per line. A longer line, a line that is not JSON, and an event of another protocol version are reported as `protocol-error` and dropped; they never throw.

## Why a separate process

The library does not export `ApplicationCore` or any other way to run the agent inside the embedding process. The sidecar process does its own start-up: it takes the client lease, recovers a pending state restore, loads the operator's configuration and the managed policy, and applies the approval mode, the sandbox and verification. A program that constructed the agent in its own process could skip those steps. Driving the sidecar gives an embedder exactly what the terminal UI gets, and no more.

The outcome of a turn is decided in the sidecar. `turn.outcome` is `VERIFIED` only when the verification the sidecar ran says so; the embedder reads the result and cannot set it.

## Approvals

When the sidecar's approval policy wants a person to confirm a tool call, `prompt` calls `onApproval` with the `approval.request` event (`tool`, `subject`, `preview`, `review`).

- Returning exactly `"approve"` lets that one call run.
- Anything else denies it: `"deny"`, any other value, a rejected promise, a thrown error, or no `onApproval` at all. The default is to deny.
- There is no way to approve "always". The client sends `always: false` with every approval and has no method that sends another command, so each later call asks again.

An embedder should inspect `request.review` before approving verification. The example above allows only the `node --test` verifier configured by the operator; discovered and model-declared verifier requests are denied.

The sidecar can also ask for a checkpoint choice, when sensitive content blocks the rollback checkpoint it takes before a change. The alternatives either drop the checkpoint or persist the sensitive content, and API version 1 has no way to pick one: the client cancels the turn, and `prompt` resolves with the interrupted result.

`extraArgs` is the embedder's own authority, like a command line: an embedder that passes `-y` or `--mode auto` has chosen to run without approval prompts, exactly as an operator who types it. The library never adds either, and managed policy still applies to the sidecar whatever is passed.

## Stopping

Call `shutdown()` when done, in a `finally`. It sends `shutdown` and closes the sidecar's stdin, and the sidecar ends its turn and exits. If it has not exited after `graceMs` (default 10 000) the client sends SIGTERM, and SIGKILL five seconds later. Only the child process itself is signalled, never a process group, so the embedder is not affected.

If the embedding process exits without calling `shutdown()`, the sidecar sees its stdin close and shuts itself down.

## Compatibility

- The library speaks sidecar protocol 1. The rules for protocol changes are in [PROTOCOL.md](PROTOCOL.md).
- A change to the runtime or type export list needs a new entry in `protocol/LIB_API_VERSIONS.json`; removing or changing the meaning of an export also raises `NEXUS_LIB_API_VERSION`.
- Supported on Linux x86_64 with Node 22 or 24, as Nexus itself.
