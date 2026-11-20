/**
 * Capabilities for tools that arrive at runtime from MCP servers and plugins.
 *
 * The execution spine refuses any tool that is not in the CapabilityRegistry (FAIL-001). MCP and plugin tools are
 * discovered after construction, so they must be registered with an explicit effect class or every call to them is
 * refused (audit D1, docs/INVARIANTS.md I-AUTH-2). Nothing is known about what a third-party tool does, so the
 * defaults are the conservative ones: it is treated as mutating (read-only sessions refuse it) and its effect class is
 * one that review mode asks the operator about (`egress` for a remote server, `exec` for a local process or plugin).
 * Only a tool that runs in this machine's own process space can change the workspace; a remote server cannot, so only
 * those make a verifier result stale.
 */
import type { ToolDefinition } from "../types.js";
import type { CanonicalCapability } from "./capabilities.js";

export type ExtensionOrigin =
  | { kind: "mcp"; serverName: string; url?: string; command?: string }
  | { kind: "plugin" };

export function extensionCapability(definition: ToolDefinition, origin: ExtensionOrigin): CanonicalCapability {
  const name = definition.function.name;
  const remote = origin.kind === "mcp" && Boolean(origin.url) && !origin.command;
  const from = origin.kind === "mcp" ? `MCP server '${origin.serverName}'` : "a plugin";
  return {
    id: `ext_${name}`,
    modelToolName: name,
    category: "extension",
    mutating: true,
    effect: remote ? "egress" : "exec",
    changesWorkspace: !remote,
    sideEffectContract: `Provided by ${from}; effects are not known to Nexus, so it is treated as ${remote ? "sending data off this machine" : "running local code"}.`,
    backend: "extension",
    toolDefinition: definition,
  };
}

/** The registry keys of every extension capability currently registered. */
export function isExtensionCapability(capability: Pick<CanonicalCapability, "category">): boolean {
  return capability.category === "extension";
}
