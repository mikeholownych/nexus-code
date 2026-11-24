# Tool registry

A tool is one registered pair: a **spec** (what the model sees and what the tool may affect) and a **binding** (how a call of it runs). Everything that needs to know about tools reads one `ToolRegistry` (`cli/src/core/tool_registry.ts`): the model-visible list, the route a call takes through the execution spine, and the lists derived from the shipped catalogue (the parser's known tool names, what `nexus serve-mcp` lists).

## Add a tool

1. Write the spec as a `CanonicalCapability` in `cli/src/core/capability_definitions/` and add it to `BASELINE_CAPABILITIES` (`core/capabilities.ts`). The spec fixes `effect` (`read_workspace`, `write_workspace`, `exec`, `egress`, `delegate`, `context_inject`, `internal`), `mutating`, `changesWorkspace` and the exact `toolDefinition` schema.
2. Give it a binding in `createToolRegistry`:
   - `native`: runs in-process. Pass `handler` in the binding, or register it on the spine in `setupSpineHandlers` (`core/spine_handlers.ts`).
   - `bridge`: runs in the Rust core through `RustCoreBridge.executeTool`. A spec with the `rust_rpc` backend is bridged without further work.
   - `extension`: MCP and plugin tools only. The agent registers them as they connect; do not register one by hand.
3. Choose an `offer` rule: when the model is offered the tool (`group`, `skills`, `always`, `objective`, `requirements`, `mask`, `until-all-groups`). A tool in a tool group (`core/tool_groups.ts`) uses `group`.
4. If `nexus serve-mcp` must not list it because it needs the model loop, set `agentBound`.

That is all: the model-visible list, the dispatch route, the parser's known names and the serve-mcp list follow. Run `tool_registry`, `tool_surface_characterization` and `tool_dispatch_characterization`; the last two are golden files that change on purpose when the catalogue grows (see `cli/test/helpers/tool_characterization.ts` for how to re-record, and review the diff). A new tool also needs a row in the ACP kind table (`acp/mapping.ts`); without one it is reported to ACP clients as `other`.

```ts
const registry = new ToolRegistry();
registry.register({
  spec,                                          // a CanonicalCapability
  binding: { kind: "native", handler },          // how a call runs
  offer: "group",
  baseline: true,                                // part of the derived lists
});
```

## What registration refuses

`register` throws, and registers nothing, for:

- a name that is already registered;
- a spec that carries its own `handler` next to a binding (a tool has one source for how it runs);
- a spec without a binding;
- an extension whose effect is not `exec` or `egress`. An extension therefore cannot register as `read_workspace` or `internal`, which never ask the operator; and the extension category, backend and binding must agree.

## What the registry does not do

It has no member that lowers an effect, marks a tool approval-free, or overrides the operator decision. Whether a call is asked, denied or run is decided in dispatch (`core/dispatch_tool_call.ts`) from the registered effect, the mode and the policy, as before. `tool_registry.test.ts` asserts the exported members, so adding such a member fails a test.

## How a call is routed

`ExecutionSpine` resolves the handler in this order: a handler registered on the spine; the handler on the tool's `native` binding; the handler set on its capability (the bridged tools get theirs from `registerBridgeCapabilities`, which asks `isBridgeBound`, the same predicate that gives them the `bridge` binding). With none, the call goes to the invocation context's default handler (MCP, plugin and plugin pipeline) and then to the bridge. A tool the registry does not hold is refused (FAIL-001).

## Model-visible order

`modelTools` returns the registered tools whose offer rule holds, ordered by rule (`group` and `skills`, `until-all-groups`, `objective`, `requirements`, `always`, `mask`) and by registration order within a rule, then the connected MCP and plugin tools, then the role allow and deny lists and a delegated allow-list. Changing this order changes every provider request and breaks the prompt cache, so `tool_surface_characterization` pins it byte for byte.
