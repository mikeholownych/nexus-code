/**
 * PF-4: the library entry point (`exports["."]` of cli/package.json). Importing it runs nothing: no command parsing,
 * no exit, no output, no read of HOME or the environment. It drives Nexus only as a separate sidecar process, so an
 * embedder cannot skip the sidecar's start-up checks; `ApplicationCore` is deliberately not exported (docs/EMBEDDING.md).
 *
 * The export list is recorded in docs/protocol/LIB_API_VERSIONS.json; changing it needs a new entry there.
 */
export const NEXUS_LIB_API_VERSION = 1;
export { spawnSidecar, SidecarClient, SidecarClientError } from "./sidecar_client.js";
export type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  PromptOptions,
  SidecarChild,
  SidecarClientErrorCode,
  SidecarExit,
  SpawnSidecarOptions,
} from "./sidecar_client.js";
export type { ErrorCode, SidecarCommand, SidecarEvent } from "./protocol.js";
export type { EngineeringOutcome, ExecutionState, TurnResult } from "./core/turn.js";
