# P10-02: Async plugin execution containment

## Assessment scope

Repository state: `origin/release/v1.3.1` at `a1f07419ba63402eb5f01dfe85783ae282aa9817`.

This note assesses whether plugin callbacks that participate in an agent turn have an enforced execution deadline. It does not claim that every plugin is unsafe or that plugin code has caused a production failure. It distinguishes a source-level gap from the controlled probes below.

## Implementation evidence

The current plugin API exposes these asynchronous entry points in `cli/src/plugins.ts`:

- `executeCustomTool` returns the registered handler promise directly (`440-446`).
- Pre-tool middleware returns the callback's promise directly; the `next()` closure dispatches the next middleware or the core executor (`470-496`).
- Post-tool middleware is awaited after the core executor (`498-524`).
- `notifyTurnStart`, `notifyToolCall`, `notifyToolResult`, and `notifyTurnEnd` await each plugin callback in order (`549-585`). Callback errors are swallowed for observer hooks, but a callback that never settles is not an error and stalls the caller.

`executeToolCall` awaits `notifyToolCall` before it persists the operation start or dispatches the tool (`cli/src/core/tool_pipeline.ts:881-904`). Custom tools and middleware then return through the same direct-await methods. None of these contexts includes a deadline or `AbortSignal`.

There is a process-boundary precedent in `cli/src/core/hook_runner.ts`: it starts a separate process group, imposes a hard deadline, bounds stdout/stderr, and terminates the process tree (`1-7,24-53,91-200`). That runner is not a drop-in plugin runner: command hooks use one-way JSON input/output and a deny-only result reducer, while plugins keep module state and expose callbacks, custom tools, and middleware continuations.

## Adversarial probes

Both probes ran from the isolated worktree at the release head, Node `v24.11.1`, with throwaway `HOME` and `XDG_CONFIG_HOME`. They used in-memory fixtures and did not access user workspaces or external services.

### Delayed custom-tool effect

Hypothesis: the custom tool method has no internal deadline and a plugin handler can complete after a caller has stopped waiting.

Setup: register an in-memory custom tool that waits 60 ms, increments an effect counter, and returns success. Observe the Nexus method with an external 10 ms `Promise.race`, then wait for the handler to settle.

Exact command (from `cli/`):

```sh
audit_home=$(mktemp -d /var/tmp/nexus-p10-plugin-probe-home.XXXXXX)
HOME="$audit_home" XDG_CONFIG_HOME="$audit_home/.config" node --import tsx --input-type=module -e 'import { PluginManager } from "./src/plugins.ts"; const pm = new PluginManager(process.cwd(), {readOnly:true}); let effects=0; pm.registerPlugin({name:"probe", customTools:[{definition:{type:"function",function:{name:"delayed"}},handler:async()=>{await new Promise(r=>setTimeout(r,60));effects++;return {success:true,output:"done"}}}]}); const pending=pm.executeCustomTool("delayed",{}); const observed=await Promise.race([pending.then(()=>"settled"),new Promise(r=>setTimeout(()=>r("still pending at 10ms"),10))]); await new Promise(r=>setTimeout(r,100)); process.stdout.write(JSON.stringify({observed,effectsAfterDeadline:effects})+"\n");'
```

Observed output: `{"observed":"still pending at 10ms","effectsAfterDeadline":1}`. Exit status: `0`.

Interpretation: a caller-side timeout would not stop this in-process handler. The effect counter is a controlled fixture, not a real workspace mutation.

### Middleware continuation after caller timeout

Hypothesis: if a caller wraps current middleware execution in `Promise.race`, middleware can call `next()` after the caller reports timeout, causing core dispatch after the deadline.

Setup: register an in-memory pre-tool middleware that waits 60 ms and then calls `next()`. The core executor increments a counter. Observe the pipeline using an external 10 ms `Promise.race`.

Exact command (from `cli/`):

```sh
audit_home=$(mktemp -d /var/tmp/nexus-p10-plugin-middleware-home.XXXXXX)
HOME="$audit_home" XDG_CONFIG_HOME="$audit_home/.config" node --import tsx --input-type=module -e 'import { PluginManager } from "./src/plugins.ts"; const pm = new PluginManager(process.cwd(), {readOnly:true}); let coreCalls=0; pm.registerPlugin({name:"probe",preToolExecution:async(_ctx,next)=>{await new Promise(r=>setTimeout(r,60));return next()}}); const pending=pm.executeToolPipeline("write_file",{},async()=>{coreCalls++;return {success:true,output:"written"}}); const observed=await Promise.race([pending.then(()=>"settled"),new Promise(r=>setTimeout(()=>r("still pending at 10ms"),10))]); await new Promise(r=>setTimeout(r,100)); process.stdout.write(JSON.stringify({observed,coreCallsAfterDeadline:coreCalls})+"\n");'
```

Observed output: `{"observed":"still pending at 10ms","coreCallsAfterDeadline":1}`. Exit status: `0`.

Interpretation: a promise race by itself can create a late tool dispatch. A safe deadline must prevent a timed-out plugin from invoking a parent-owned continuation, as well as stop the plugin process.

Classification: both probes are **FAIL** for bounded waiting/termination in the current in-process plugin path. They establish behavior for the directly exercised methods, not every live turn configuration.

## Provider timeout check

The same isolated release-head worktree ran:

```sh
audit_home=$(mktemp -d /var/tmp/nexus-p10-provider-home.XXXXXX)
HOME="$audit_home" XDG_CONFIG_HOME="$audit_home/.config" node --import tsx --test test/provider_robustness.test.ts test/inference_transport.test.ts
```

Node `v24.11.1`; exit `0`; 46 tests passed, 0 failed, 0 skipped. Coverage included silent-server and slow-drip whole-request deadline cases and caller abort. This supports finite local request deadlines for the tested inference client paths. It does not show whether a remote provider stops work or billing after Nexus aborts its local request.

## Risk and maturity

Severity: **High** for long-running autonomous sessions. A stalled plugin can prevent turn completion; a late custom-handler effect or late `next()` can occur after an outer caller has stopped waiting. Reachability is limited to active installed/approved plugins, but observer callbacks are called on the tool and turn paths. Blast radius is at least one session and can include workspace or external effects if the handler has those capabilities. Detection may be delayed until the user notices a stalled turn; after a naive timeout it may be silent. In-process promises are not force-cancelable, so recovery may require stopping Nexus, and already-started side effects can be irreversible or have unknown outcomes.

Maturity: **M2**. The plugin API and dispatch are implemented, and workspace plugin loading has trust checks, but this execution path has no runtime deadline, cancellation contract, or negative timeout test. Trusting a plugin does not constitute a bounded execution guarantee.

## Remediation design

Add a focused WP-P10-02 slice that isolates each plugin module in a killable worker process, with bounded JSON IPC for lifecycle hooks, custom-tool calls, and middleware. Preserve the existing plugin contract where feasible, but do not provide an in-process fallback when the worker times out or fails. Version the IPC protocol and define behavior for existing plugins before rollout.

The parent process must own middleware continuation. A worker's `next()` request is an RPC to the parent; after its deadline, the parent rejects it and must not call the core executor. If `next()` completed before a timeout and the operation may have started, record/return `outcomeUnknown` unless a durable result is observed. Timeout must not be reported as successful completion. Bound messages and outputs, classify malformed worker responses as failure, and terminate the worker's process group using or extracting the existing `hook_runner.ts` process-tree mechanism rather than duplicating unrelated process tracking.

Do not claim this is a security sandbox: operator-approved plugins continue to have whatever filesystem/network access the worker environment grants. The guarantee sought here is bounded lifetime and explicit result/unknown-outcome handling. Any required sandboxing or secret removal is a separate policy decision and must preserve documented plugin behavior.

### Mechanical acceptance criteria

1. Every plugin callback path (turn start/end, tool call/result observers, custom tool, pre middleware, post middleware) has a finite, policy-capped deadline enforced by the parent process.
2. A synchronous infinite loop and a never-settling promise do not block the parent past the configured deadline plus the documented termination grace.
3. A worker that times out or exits cannot dispatch `next()` afterward; a fixture verifies the core executor is not called after timeout.
4. A side effect that may have started before timeout is reported as unknown and cannot be presented as success or blindly replayed by the current call path.
5. Oversized, malformed, late, or duplicate IPC responses fail closed; stdout/stderr and IPC payload sizes are bounded.
6. Process-tree tests cover an ordinary child and a detached child; Nexus confirms termination or retains an explicit unresolved-process failure rather than claiming cleanup.
7. Repeated timed-out calls do not accumulate worker processes, open pipes, or retained sessions; cancellation and Nexus shutdown terminate owned workers.
8. Existing plugin examples and compatibility fixtures pass through the isolated protocol, or a versioned migration produces an explicit load refusal with operator guidance.
9. Test coverage runs on Node 22 and 24, including all negative cases above; no live inference or paid service is needed.

## Limitations

No process isolation change was implemented in this assessment slice. These probes do not test host restart, OS-level resource limits, malicious plugins that deliberately escape process-group containment, or production plugin behavior. No claim is made that a remote provider stops processing after local abort.
