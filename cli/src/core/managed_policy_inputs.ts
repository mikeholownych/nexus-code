/**
 * GV-1: the production inputs of `loadManagedPolicy`, computed in one place. Nothing calls this yet.
 *
 * The system path is the constant of managed_policy_load.ts and the owner is root; neither can be changed from the
 * environment or the command line. The user file and the approval store sit in the operator's Nexus configuration
 * directory, derived as workspace_trust.ts derives the trust store. The workspace and the trust facts are the caller's.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { POLICY_TRUST_FILE_NAME, SYSTEM_POLICY_PATH, USER_POLICY_FILE_NAME, type LoadManagedPolicyInput } from "./managed_policy_load.js";

export type ProductionPolicyInputs = Pick<LoadManagedPolicyInput, "systemPath" | "systemOwnerUid" | "userPath" | "userUid" | "fs"> & {
  /** Where approvals of project policy files are kept. */
  trustStorePath: string;
};

export function resolveProductionPolicyInputs(): ProductionPolicyInputs {
  const configDir = path.join(os.homedir(), ".config", "nexus");
  // Windows has no system tier and no POSIX owners.
  const posix = process.platform !== "win32" && typeof process.geteuid === "function";
  return {
    systemPath: posix ? SYSTEM_POLICY_PATH : null,
    systemOwnerUid: 0,
    userPath: path.join(configDir, USER_POLICY_FILE_NAME),
    userUid: posix ? process.geteuid!() : null,
    trustStorePath: path.join(configDir, POLICY_TRUST_FILE_NAME),
    fs,
  };
}
