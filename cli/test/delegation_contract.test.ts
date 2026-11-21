import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationOutcome, resolveDelegationContract, type DelegationAuthorityLayer, type DelegationContract } from "../src/core/delegation_contract.js";

const base = {
  id: "child-1",
  parentId: "parent-1",
  objective: "Inspect the requested files",
  profile: "semantic_explorer",
  inputs: {},
  authorizedScope: ["src"],
  permittedCapabilities: ["fs_read", "code_search_lexical"],
  executionMode: "transient" as const,
  requiresVerification: true,
  requiresIndependentReview: false,
};

function authority(overrides: Partial<DelegationAuthorityLayer> = {}): DelegationAuthorityLayer {
  return {
    source: "parent",
    permittedCapabilities: ["fs_read", "code_search_lexical", "proc_exec"],
    authorizedScope: ["*"],
    ...overrides,
  };
}

test("delegation authority is the intersection of parent, profile, session, workspace and task policy", () => {
  const resolved = resolveDelegationContract({ ...base, authorizedScope: ["src/lib"], permittedCapabilities: ["fs_read"] }, [
    authority(),
    authority({ source: "profile", permittedCapabilities: ["fs_read", "code_search_lexical"], authorizedScope: ["src"] }),
    authority({ source: "task", permittedCapabilities: ["fs_read"], authorizedScope: ["src/lib"] }),
    authority({ source: "session", permittedCapabilities: ["fs_read", "proc_exec"], authorizedScope: ["src"] }),
    authority({ source: "workspace", permittedCapabilities: ["fs_read", "code_search_lexical"], authorizedScope: ["src"] }),
  ]);

  assert.deepEqual(resolved.permittedCapabilities, ["fs_read"]);
  assert.deepEqual(resolved.authorizedScope, ["src/lib"]);
});

test("delegation cannot request a capability outside inherited authority", () => {
  assert.throws(
    () => resolveDelegationContract({ ...base, permittedCapabilities: ["fs_read", "admin_exec"] }, [authority()]),
    /unauthorized capability.*admin_exec/,
  );
});

test("delegation cannot broaden inherited path scope", () => {
  assert.throws(
    () => resolveDelegationContract({ ...base, authorizedScope: ["src", "secrets"] }, [authority({ authorizedScope: ["src/lib"] })]),
    /outside inherited scope.*secrets/,
  );
});

test("capability identities normalize before intersection and empty policy fails closed", () => {
  const normalized = resolveDelegationContract(
    { ...base, permittedCapabilities: [" FS_READ ", "FS_READ"] },
    [authority({ permittedCapabilities: ["fs_read"] })],
  );
  assert.deepEqual(normalized.permittedCapabilities, ["fs_read"]);
  const denied = resolveDelegationContract({ ...base, permittedCapabilities: [], authorizedScope: [] }, []);
  assert.deepEqual(denied.permittedCapabilities, []);
  assert.deepEqual(denied.authorizedScope, []);
});

test("malformed model-generated authority fields are refused before admission", () => {
  assert.throws(
    () => resolveDelegationContract({ ...base, permittedCapabilities: undefined as unknown as string[] }, [authority()]),
    /permittedCapabilities.*must be an array/,
  );
  assert.throws(
    () => resolveDelegationContract({ ...base, modelRequirements: [] as unknown as DelegationContract["modelRequirements"] }, [authority()]),
    /modelRequirements.*must be an object/,
  );
});

test("resolved authority cannot be widened by mutating the returned contract", () => {
  const resolved = resolveDelegationContract({ ...base, permittedCapabilities: ["fs_read"] }, [authority()]);

  assert.throws(() => resolved.permittedCapabilities.push("proc_exec"), TypeError);
  assert.deepEqual(resolved.permittedCapabilities, ["fs_read"]);
});

test("delegation outcomes preserve all terminal states and keep evidence and obligations separate", () => {
  const statuses = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED", "UNKNOWN_EFFECT"] as const;
  const outcomes = statuses.map((status) => createDelegationOutcome({
    id: `child-${status.toLowerCase()}`,
    parentId: "parent-1",
    status,
    summary: "Partial report",
    evidence: [{ kind: "test", reference: "test.log", digest: "abc123" }],
    uncertainty: status === "UNKNOWN_EFFECT" ? ["write may have reached the filesystem"] : [],
    resourceUsage: {
      inferenceRequests: 2,
      toolCalls: 3,
      elapsedMs: 1250,
      inputTokens: { value: 120, source: "estimated" },
    },
    outstandingObligations: ["verify the generated file"],
  }));

  assert.deepEqual(outcomes.map((outcome) => outcome.status), statuses);
  assert.deepEqual(outcomes[5].uncertainty, ["write may have reached the filesystem"]);
  assert.deepEqual(outcomes[0].outstandingObligations, ["verify the generated file"]);
  assert.equal(outcomes[0].resourceUsage.inputTokens?.source, "estimated");
});

test("delegation outcomes reject impossible or unlabeled resource measurements", () => {
  assert.throws(
    () => createDelegationOutcome({
      id: "child-bad",
      parentId: "parent-1",
      status: "COMPLETED",
      summary: "Done",
      evidence: [],
      uncertainty: [],
      resourceUsage: { inferenceRequests: -1, toolCalls: 0, elapsedMs: 10 },
      outstandingObligations: [],
    }),
    /inferenceRequests must be a non-negative integer/,
  );
  assert.throws(
    () => createDelegationOutcome({
      id: "child-unlabeled",
      parentId: "parent-1",
      status: "COMPLETED",
      summary: "Done",
      evidence: [],
      uncertainty: [],
      resourceUsage: { inferenceRequests: 1, toolCalls: 0, elapsedMs: 10, inputTokens: { value: 42, source: "observed" } },
      outstandingObligations: [],
    } as unknown as DelegationOutcome),
    /token usage source must be reported or estimated/,
  );
});
