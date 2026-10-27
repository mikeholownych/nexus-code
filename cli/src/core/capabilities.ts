/**
 * Canonical Capabilities & Model-Visible Tool Registry
 * Nexus Issue #12 — WP-01 (INC-01, CAP-001..007, DEDUP-001..004)
 */

import { ToolDefinition, ExecutionResult } from "../types.js";

import {
  readFileCapability,
  writeFileCapability,
  editFileCapability,
  listDirCapability,
  findFilesCapability,
  deleteFileCapability,
  fileInfoCapability,
  batchReadCapability,
  fileTreeCapability,
  patchFileCapability,
} from "./capability_definitions/fs.js";
import {
  searchCodeCapability,
  searchSymbolsCapability,
  cstSymbolsCapability,
  outlineFileCapability,
  trigramSearchCapability,
  hybridSearchCapability,
} from "./capability_definitions/code_search.js";
import {
  runCommandCapability,
  runTestsCapability,
} from "./capability_definitions/proc.js";
import {
  fetchWebCapability,
  searchWebCapability,
} from "./capability_definitions/net.js";
import {
  taskCompletedCapability,
  spawnSubagentCapability,
  updatePlanCapability,
} from "./capability_definitions/orchestration.js";
import { activateSkillCapability } from "./capability_definitions/skill.js";
import {
  lspHoverCapability,
  lspDefinitionCapability,
  lspDiagnosticsCapability,
} from "./capability_definitions/lsp.js";
import {
  gitStatusCapability,
  gitDiffCapability,
  gitLogCapability,
} from "./capability_definitions/vcs.js";
import {
  browserNavigateCapability,
  browserScreenshotCapability,
  browserClickCapability,
  browserTypeCapability,
  browserConsoleLogsCapability,
} from "./capability_definitions/browser.js";
import { manageKnowledgeCapability } from "./capability_definitions/knowledge.js";

export type CapabilityBackend = "rust_rpc" | "ts_native" | "extension";

/**
 * What a capability can affect (SPEC-01 §5.1). Review mode asks the operator before `write_workspace`, `exec` and
 * `egress`; `context_inject` is gated by workspace trust instead; `read_workspace`, `delegate` (the child's own calls are
 * gated) and `internal` (Nexus's own bookkeeping, no effect outside the conversation) never ask.
 */
export type EffectClass = "read_workspace" | "write_workspace" | "exec" | "egress" | "delegate" | "context_inject" | "internal";

export const EFFECT_CLASSES: readonly EffectClass[] = ["read_workspace", "write_workspace", "exec", "egress", "delegate", "context_inject", "internal"];

/** Whether review mode asks the operator before a capability of this class runs. */
export function needsOperatorDecision(effect: EffectClass): boolean {
  return effect === "write_workspace" || effect === "exec" || effect === "egress";
}

export interface CanonicalCapability {
  /** Canonical capability identifier (e.g., 'fs_read', 'proc_exec') */
  id: string;
  /** Model-visible tool name matching LLM schemas (e.g., 'read_file', 'run_command') */
  modelToolName: string;
  /** Category of capability */
  category:
    | "fs"
    | "code_search"
    | "proc"
    | "vcs"
    | "net"
    | "lsp"
    | "browser"
    | "knowledge"
    | "skill"
    | "orchestration"
    | "extension"
    | string;
  /** Whether the capability performs side effects (read-only mode refuses it) */
  mutating: boolean;
  /** What the capability can affect; decides whether review mode asks before it runs */
  effect: EffectClass;
  /**
   * Whether a successful call changes the workspace content (makes a verifier result stale, counts as a change to
   * verify). Defaults to `mutating`; false for side effects outside the workspace, such as running tests.
   */
  changesWorkspace?: boolean;
  /** Human- and audit-readable side-effect contract */
  sideEffectContract: string;
  /** Backend execution engine type */
  backend: CapabilityBackend;
  /** Exact model tool definition (JSON schema) presented to LLMs */
  toolDefinition: ToolDefinition;
  /** Optional registered capability execution handler */
  handler?: CapabilityHandler;
}

export type CapabilityHandler = (
  args: Record<string, any>,
  context: any
) => Promise<ExecutionResult>;

export class CapabilityRegistry {
  private readonly capabilitiesByToolName = new Map<string, CanonicalCapability>();
  private readonly capabilitiesById = new Map<string, CanonicalCapability[]>();

  constructor(capabilities: CanonicalCapability[] = []) {
    for (const cap of capabilities) {
      this.register(cap);
    }
  }

  /**
   * Register a canonical capability.
   * Throws if a capability with the same modelToolName is already registered.
   */
  public register(capability: CanonicalCapability): void {
    if (!capability || !capability.id || !capability.modelToolName) {
      throw new Error("Invalid capability: id and modelToolName are required.");
    }
    if (!EFFECT_CLASSES.includes(capability.effect)) {
      throw new Error(`Invalid capability '${capability.modelToolName}': effect must be one of ${EFFECT_CLASSES.join(", ")}.`);
    }
    if (this.capabilitiesByToolName.has(capability.modelToolName)) {
      throw new Error(`Duplicate capability registration: model tool '${capability.modelToolName}' is already registered.`);
    }

    this.capabilitiesByToolName.set(capability.modelToolName, capability);

    const list = this.capabilitiesById.get(capability.id) || [];
    list.push(capability);
    this.capabilitiesById.set(capability.id, list);
  }

  /**
   * Unregister a capability by its tool name or canonical ID.
   */
  public unregister(toolNameOrId: string): boolean {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap) {
      this.capabilitiesByToolName.delete(cap.modelToolName);
      const list = this.capabilitiesById.get(cap.id);
      if (list) {
        const filtered = list.filter((c) => c.modelToolName !== cap.modelToolName);
        if (filtered.length > 0) {
          this.capabilitiesById.set(cap.id, filtered);
        } else {
          this.capabilitiesById.delete(cap.id);
        }
      }
      return true;
    }

    if (this.capabilitiesById.has(toolNameOrId)) {
      const caps = this.capabilitiesById.get(toolNameOrId)!;
      for (const c of caps) {
        this.capabilitiesByToolName.delete(c.modelToolName);
      }
      this.capabilitiesById.delete(toolNameOrId);
      return true;
    }

    return false;
  }

  /**
   * Retrieve capability by model tool name.
   */
  public getByToolName(toolName: string): CanonicalCapability | undefined {
    return this.capabilitiesByToolName.get(toolName);
  }

  /**
   * Retrieve capability by canonical capability ID (returns first registered).
   */
  public getById(id: string): CanonicalCapability | undefined {
    const list = this.capabilitiesById.get(id);
    return list && list.length > 0 ? list[0] : undefined;
  }

  /**
   * Retrieve all capabilities matching a canonical ID.
   */
  public getAllById(id: string): CanonicalCapability[] {
    return this.capabilitiesById.get(id) || [];
  }

  /**
   * Check if a model tool name is registered.
   */
  public hasTool(toolName: string): boolean {
    return this.capabilitiesByToolName.has(toolName);
  }

  /**
   * Check if a canonical ID is registered.
   */
  public hasCapability(id: string): boolean {
    return this.capabilitiesById.has(id);
  }

  /**
   * List all registered canonical capabilities.
   */
  public listCapabilities(): CanonicalCapability[] {
    return Array.from(this.capabilitiesByToolName.values());
  }

  /**
   * List all model-visible tool definitions (100% schema parity).
   */
  public listModelTools(): ToolDefinition[] {
    return Array.from(this.capabilitiesByToolName.values()).map((cap) => cap.toolDefinition);
  }

  /**
   * Attach an execution handler to a capability by model tool name or canonical ID.
   */
  public setHandler(toolNameOrId: string, handler: CapabilityHandler): void {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap) {
      cap.handler = handler;
      return;
    }
    const caps = this.capabilitiesById.get(toolNameOrId);
    if (caps && caps.length > 0) {
      for (const c of caps) {
        c.handler = handler;
      }
      return;
    }
    throw new Error(`Cannot set handler: capability '${toolNameOrId}' not found.`);
  }

  /**
   * Get handler for a tool name or canonical ID.
   */
  public getHandler(toolNameOrId: string): CapabilityHandler | undefined {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap && cap.handler) {
      return cap.handler;
    }
    const list = this.capabilitiesById.get(toolNameOrId);
    if (list && list.length > 0 && list[0].handler) {
      return list[0].handler;
    }
    return undefined;
  }
}

/** Whether a successful call of the capability changes workspace content. */
export function changesWorkspace(capability: Pick<CanonicalCapability, "mutating" | "changesWorkspace">): boolean {
  return capability.changesWorkspace ?? capability.mutating;
}

export const BASELINE_CAPABILITIES: CanonicalCapability[] = [
  readFileCapability,
  writeFileCapability,
  editFileCapability,
  listDirCapability,
  searchCodeCapability,
  runCommandCapability,
  findFilesCapability,
  searchSymbolsCapability,
  deleteFileCapability,
  fetchWebCapability,
  taskCompletedCapability,
  spawnSubagentCapability,
  fileInfoCapability,
  batchReadCapability,
  fileTreeCapability,
  patchFileCapability,
  updatePlanCapability,
  activateSkillCapability,
  runTestsCapability,
  searchWebCapability,
  lspHoverCapability,
  lspDefinitionCapability,
  lspDiagnosticsCapability,
  gitStatusCapability,
  gitDiffCapability,
  gitLogCapability,
  cstSymbolsCapability,
  outlineFileCapability,
  trigramSearchCapability,
  hybridSearchCapability,
  browserNavigateCapability,
  browserScreenshotCapability,
  browserClickCapability,
  browserTypeCapability,
  browserConsoleLogsCapability,
  manageKnowledgeCapability,
];

export function createDefaultRegistry(): CapabilityRegistry {
  return new CapabilityRegistry(BASELINE_CAPABILITIES.map((c) => ({ ...c })));
}

export const defaultRegistry = createDefaultRegistry();
export const HARNESS_TOOLS: ToolDefinition[] = defaultRegistry.listModelTools();
