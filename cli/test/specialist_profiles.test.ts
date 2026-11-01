import test from "node:test";
import assert from "node:assert/strict";
import {
  SPECIALIST_CONTRACTS,
  validateSpecialistToolAccess,
  validateSpecialistOutput,
  ToolAccessDeniedError,
  isSpecialistRole,
  type SpecialistRole,
} from "../src/core/specialist_profiles.js";

test("specialist profiles declare explicit permitted tools and bounds", () => {
  const roles: SpecialistRole[] = [
    "semantic_explorer",
    "call_site_analyzer",
    "failure_debugger",
    "security_reviewer",
    "acceptance_reviewer",
  ];

  for (const role of roles) {
    const contract = SPECIALIST_CONTRACTS[role];
    assert.ok(contract, `Contract must exist for role: ${role}`);
    assert.equal(contract.role, role);
    assert.ok(contract.permittedTools.length > 0, `${role} must declare permitted tools`);
    const canExecute = contract.permittedTools.some((t) => t === "run_command" || t === "run_tests");
    assert.equal(contract.readOnly, !canExecute, `${role}: readOnly must be false exactly when it may run commands`);
    assert.ok(contract.maxContextTokens > 0, `${role} must declare a maxContextTokens ceiling`);
    assert.ok(contract.inputRequirements.length > 0, `${role} must declare input requirements`);
    assert.ok(contract.escalationCriteria.length > 0, `${role} must declare escalation criteria`);
  }
});

test("isSpecialistRole identifies valid specialist roles and resists prototype poisoning", () => {
  assert.equal(isSpecialistRole("semantic_explorer"), true);
  assert.equal(isSpecialistRole("call_site_analyzer"), true);
  assert.equal(isSpecialistRole("unknown_role"), false);
  assert.equal(isSpecialistRole("constructor"), false);
  assert.equal(isSpecialistRole("toString"), false);
  assert.equal(isSpecialistRole("__proto__"), false);
  assert.equal(isSpecialistRole(undefined), false);

  assert.throws(() => {
    validateSpecialistToolAccess("constructor" as any, "read_file");
  }, /Unknown specialist role: 'constructor'/);
});

test("validateSpecialistToolAccess permits whitelisted tools and blocks unauthorized tools", () => {
  // semantic_explorer permits read_file, search_code, etc.
  assert.doesNotThrow(() => {
    validateSpecialistToolAccess("semantic_explorer", "read_file");
  });
  assert.doesNotThrow(() => {
    validateSpecialistToolAccess("semantic_explorer", "search_symbols");
  });

  // Disallowed mutating tool: write_file
  assert.throws(
    () => {
      validateSpecialistToolAccess("semantic_explorer", "write_file");
    },
    (err: unknown) => {
      assert.ok(err instanceof ToolAccessDeniedError);
      assert.equal(err.role, "semantic_explorer");
      assert.equal(err.toolName, "write_file");
      assert.match(err.message, /not permitted to execute tool 'write_file'/);
      return true;
    },
  );

  // Unknown role throws an error
  assert.throws(() => {
    validateSpecialistToolAccess("non_existent" as SpecialistRole, "read_file");
  }, /Unknown specialist role/);
});

test("validateSpecialistOutput validates structured specialist payloads", () => {
  const validPayload = {
    specialistRole: "call_site_analyzer",
    status: "SUCCESS",
    summary: "Identified 4 downstream call sites for calculateHash()",
    findings: { callSites: ["src/a.ts:12", "src/b.ts:45"] },
    evidence: [{ path: "src/a.ts", lineRange: [10, 15], note: "Direct caller" }],
    escalationRecommended: false,
  };

  const validated = validateSpecialistOutput("call_site_analyzer", validPayload);
  assert.equal(validated.specialistRole, "call_site_analyzer");
  assert.equal(validated.status, "SUCCESS");
  assert.equal(validated.evidence.length, 1);

  // Mismatched role fails
  assert.throws(() => {
    validateSpecialistOutput("security_reviewer", validPayload);
  }, /Specialist output role mismatch/);

  // Invalid status fails
  assert.throws(() => {
    validateSpecialistOutput("call_site_analyzer", { ...validPayload, status: "CORRUPT" });
  }, /Invalid specialist status/);

  // Missing summary fails
  assert.throws(() => {
    validateSpecialistOutput("call_site_analyzer", { ...validPayload, summary: "" });
  }, /must include a non-empty summary/);

  // Malformed evidence fails
  assert.throws(() => {
    validateSpecialistOutput("call_site_analyzer", { ...validPayload, evidence: "not an array" });
  }, /must include an evidence array/);
});
