import { test, describe } from "node:test";
import assert from "node:assert";
import {
  CapabilityRegistry,
  createDefaultRegistry,
  defaultRegistry,
  HARNESS_TOOLS,
  CanonicalCapability,
} from "../src/core/capabilities.js";

describe("WP-01: CapabilityRegistry & Canonical Capability Model (INC-01)", () => {
  test("CAP-001 & CAP-006: Authoritative registration of exactly 36 canonical capabilities", () => {
    const registry = createDefaultRegistry();
    const capabilities = registry.listCapabilities();
    const modelTools = registry.listModelTools();

    assert.strictEqual(capabilities.length, 36, "Registry must contain exactly 36 canonical capabilities");
    assert.strictEqual(modelTools.length, 36, "Model tools list must contain exactly 36 tool definitions");
  });

  // HARNESS_TOOLS is generated from the registry, so their schemas cannot diverge; what is checked is that every
  // baseline tool is still offered. (A byte comparison against a migration snapshot outside the repository was removed:
  // it ran only where that file existed and failed on every intended schema change.)
  test("DEDUP-003: every baseline tool is offered and registered", () => {
    const toolNames = HARNESS_TOOLS.map((t) => t.function.name);
    const expected36 = [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "search_code",
      "run_command",
      "find_files",
      "search_symbols",
      "delete_file",
      "fetch_web",
      "task_completed",
      "spawn_subagent",
      "file_info",
      "batch_read",
      "file_tree",
      "patch_file",
      "update_plan",
      "activate_skill",
      "run_tests",
      "search_web",
      "lsp_hover",
      "lsp_definition",
      "lsp_diagnostics",
      "git_status",
      "git_diff",
      "git_log",
      "cst_symbols",
      "outline_file",
      "trigram_search",
      "hybrid_search",
      "browser_navigate",
      "browser_screenshot",
      "browser_click",
      "browser_type",
      "browser_console_logs",
      "manage_knowledge",
    ];

    for (const name of expected36) {
      assert.ok(toolNames.includes(name), `Missing expected baseline tool: ${name}`);
      assert.ok(defaultRegistry.hasTool(name), `defaultRegistry must contain tool: ${name}`);
    }
  });

  test("CAP-001 & CAP-002: Lookup by model tool name and canonical capability ID", () => {
    const registry = createDefaultRegistry();

    const readFile = registry.getByToolName("read_file");
    assert.ok(readFile, "read_file must be found by tool name");
    assert.strictEqual(readFile?.id, "fs_read");
    assert.strictEqual(readFile?.category, "fs");
    assert.strictEqual(readFile?.mutating, false);
    assert.strictEqual(readFile?.backend, "rust_rpc");

    const writeFile = registry.getByToolName("write_file");
    assert.ok(writeFile, "write_file must be found by tool name");
    assert.strictEqual(writeFile?.id, "fs_write");
    assert.strictEqual(writeFile?.mutating, true);

    const runCommand = registry.getByToolName("run_command");
    assert.ok(runCommand, "run_command must be found by tool name");
    assert.strictEqual(runCommand?.id, "proc_exec");
    assert.strictEqual(runCommand?.mutating, true);

    const fsRead = registry.getById("fs_read");
    assert.ok(fsRead, "fs_read must be found by canonical capability ID");
    assert.strictEqual(fsRead?.modelToolName, "read_file");

    const procExec = registry.getById("proc_exec");
    assert.ok(procExec, "proc_exec must be found by canonical capability ID");
    assert.strictEqual(procExec?.modelToolName, "run_command");
  });

  test("CAP-005: Distinct capabilities remain distinct", () => {
    const registry = createDefaultRegistry();
    const writeCap = registry.getByToolName("write_file");
    const editCap = registry.getByToolName("edit_file");
    const deleteCap = registry.getByToolName("delete_file");
    const patchCap = registry.getByToolName("patch_file");

    assert.notStrictEqual(writeCap?.id, deleteCap?.id, "write_file and delete_file must have distinct capability IDs");
    assert.notStrictEqual(writeCap?.id, editCap?.id, "write_file and edit_file must have distinct capability IDs");
    assert.notStrictEqual(editCap?.id, patchCap?.id, "edit_file and patch_file must have distinct capability IDs");
  });

  test("Negative Test: Duplicate registration rejection", () => {
    const registry = createDefaultRegistry();
    const duplicate: CanonicalCapability = {
      id: "fs_read_custom",
      modelToolName: "read_file", // already registered!
      category: "fs",
      mutating: false,
      sideEffectContract: "Duplicate read",
      backend: "ts_native",
      toolDefinition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Duplicate",
          parameters: { type: "object", properties: {} },
        },
      },
    };

    assert.throws(
      () => registry.register(duplicate),
      /Duplicate capability registration: model tool 'read_file' is already registered/,
      "Registering an already-registered tool name must throw duplicate error"
    );
  });

  test("Handler assignment and retrieval on registry", async () => {
    const registry = createDefaultRegistry();
    assert.strictEqual(registry.getHandler("read_file"), undefined);

    registry.setHandler("read_file", async (args) => ({
      success: true,
      output: `Mock read of ${args.path}`,
    }));

    const handler = registry.getHandler("read_file");
    assert.ok(handler, "Handler must be registered");
    const res = await handler({ path: "test.txt" }, {} as any);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.output, "Mock read of test.txt");
  });

  test("Unregister removes capability cleanly", () => {
    const registry = createDefaultRegistry();
    assert.ok(registry.hasTool("run_tests"));

    const removed = registry.unregister("run_tests");
    assert.strictEqual(removed, true, "Unregister must return true");
    assert.strictEqual(registry.hasTool("run_tests"), false);
    assert.strictEqual(registry.getByToolName("run_tests"), undefined);
  });
});
