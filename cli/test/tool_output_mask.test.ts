/**
 * CX-4: old tool results above a token threshold are replaced, in the request only, by a marker carrying a content id;
 * the full output stays in the conversation and the archive and resolves with read_tool_output. Opt-in
 * (NEXUS_TOOL_OUTPUT_MASK_TOKENS); the pinned ledger, findings and the independent reviewer's evidence are never masked.
 */
import "./helpers/leak_guard.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig, type ChatMessage } from "../src/types.js";
import { PINNED_LEDGER_PREFIX } from "../src/core/objective.js";
import { buildReviewEvidencePackage } from "../src/core/independent_review.js";
import { maskToolOutputs, maskedOutputId, resolveMaskedOutput, readToolOutput, MASK_MARKER_PREFIX, maskThresholdFromEnv } from "../src/core/tool_output_mask.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const big = Array.from({ length: 400 }, (_, i) => `line ${i} of the big output`).join("\n");
const turn = (id: string, name: string, output: string): ChatMessage[] => [
  { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] } as ChatMessage,
  { role: "tool", tool_call_id: id, name, content: output } as ChatMessage,
];

describe("maskToolOutputs", () => {
  const convo: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    ...turn("c1", "read_file", big),
    ...turn("c2", "read_file", big + " second"),
    { role: "assistant", content: "done" },
  ];

  test("masks old large tool outputs with a marker that names the id; never mutates its input", () => {
    const before = JSON.stringify(convo);
    const out = maskToolOutputs(convo, 100);
    assert.equal(JSON.stringify(convo), before);
    const marked = out.filter((m) => m.role === "tool").map((m) => m.content as string);
    assert.equal(marked.length, 2);
    for (const text of marked) assert.ok(text.startsWith(MASK_MARKER_PREFIX), text.slice(0, 80));
    assert.match(marked[0], new RegExp(`tool-output:${maskedOutputId(big)}`));
    assert.ok(marked[0].length < big.length / 4);
    assert.deepEqual(out.filter((m) => m.role !== "tool"), convo.filter((m) => m.role !== "tool"), "only tool results change");
  });

  test("keeps what the model has not acted on yet, small outputs, retrieval results and earlier placeholders", () => {
    const pending = [{ role: "user", content: "go" } as ChatMessage, ...turn("c1", "read_file", big)];
    assert.equal(maskToolOutputs(pending, 100), pending, "a result with no later assistant message is not masked");
    const small = [...turn("c1", "read_file", "tiny"), { role: "assistant", content: "ok" } as ChatMessage];
    assert.equal(maskToolOutputs(small, 100), small);
    for (const name of ["read_archive", "read_tool_output", "read_findings", "read_objective"]) {
      const kept = [...turn("c1", name, big), { role: "assistant", content: "ok" } as ChatMessage];
      assert.equal(maskToolOutputs(kept, 100), kept, name);
    }
    const marker = [...turn("c1", "read_file", `${MASK_MARKER_PREFIX} already`.padEnd(5000, "x")), { role: "assistant", content: "ok" } as ChatMessage];
    assert.equal(maskToolOutputs(marker, 100), marker);
  });

  test("read_tool_output requires an exact id and resolves only retained tool output", () => {
    const live = [...turn("c1", "read_file", big)];
    const id = maskedOutputId(big);
    assert.deepEqual(readToolOutput("bad", live, []), { ok: false, text: "read_tool_output needs the 12-character lowercase hexadecimal id from a tool-output marker." });
    assert.deepEqual(readToolOutput("0".repeat(12), live, []), { ok: false, text: `No tool output is available for id ${"0".repeat(12)} in this conversation.` });
    assert.deepEqual(readToolOutput(id, [], [live[1]]), { ok: true, text: big }, "works after compaction moved the result to the archive");
  });

  test("off at a missing, zero or invalid threshold", () => {
    assert.equal(maskToolOutputs(convo, 0), convo);
    assert.equal(maskToolOutputs(convo, undefined), convo);
    assert.equal(maskThresholdFromEnv({}), undefined);
    assert.equal(maskThresholdFromEnv({ NEXUS_TOOL_OUTPUT_MASK_TOKENS: "abc" }), undefined);
    assert.equal(maskThresholdFromEnv({ NEXUS_TOOL_OUTPUT_MASK_TOKENS: "0" }), undefined);
    assert.equal(maskThresholdFromEnv({ NEXUS_TOOL_OUTPUT_MASK_TOKENS: "250" }), 250);
  });

  test("the id resolves to the full output from the live conversation or the archive, and only to that", () => {
    const id = maskedOutputId(big);
    assert.equal(resolveMaskedOutput(`tool-output:${id}`, convo, []), big);
    assert.equal(resolveMaskedOutput(`tool-output:${id}`, [], [convo[3]]), big, "found in the archive after compaction");
    assert.equal(resolveMaskedOutput(`tool-output:${"0".repeat(12)}`, convo, []), undefined);
    assert.equal(resolveMaskedOutput("line 4", convo, []), undefined, "an ordinary query is not an id");
  });

  test("the independent reviewer's evidence package does not change with masking, and the review module does not depend on it", () => {
    const params = { unitId: "u", objective: "o", baselineCommit: "abc", unifiedDiff: big, verifierCommand: "npm test", verifierOutput: big, verifierExitCode: 0 };
    const unmasked = JSON.stringify(buildReviewEvidencePackage(params));
    maskToolOutputs(convo, 1);
    assert.equal(JSON.stringify(buildReviewEvidencePackage(params)), unmasked);
    assert.doesNotMatch(readFileSync(path.join(here, "..", "src", "core", "independent_review.ts"), "utf8"), /tool_output_mask/);
  });
});

describe("through the agent", () => {
  let home = "";
  let previousHome: string | undefined;
  let previousMask: string | undefined;
  before(() => {
    previousHome = process.env.HOME;
    previousMask = process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mask-home-"));
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = previousHome;
    if (previousMask === undefined) delete process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS; else process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS = previousMask;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
    endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
    continuation: { ...DEFAULT_CONTINUATION },
  });
  const read = (file: string): Reply => ({ kind: "tools", calls: [{ name: "read_file", args: { path: file } }] });
  const textOf = (m: any): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));

  async function run(mask: string | undefined): Promise<any[]> {
    if (mask === undefined) delete process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS; else process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS = mask;
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "big.txt"), big);
    fs.writeFileSync(path.join(repo, "small.txt"), "small\n");
    let id = "";
    const gw = await startGateway((n, body) => {
      if (n === 1) return read("big.txt");
      if (n === 2) return read("small.txt");
      if (n === 3) {
        id = /tool-output:([0-9a-f]{12})/.exec(JSON.stringify(body.messages))?.[1] ?? "none";
        if (id === "none") return { kind: "text", content: "done" };
        return { kind: "tools", calls: [{ name: "read_tool_output", args: { id } }] };
      }
      return { kind: "text", content: "done" };
    });
    const agent = new AutonomousAgent(cfg(gw.url, repo));
    (agent as any).ui = new Proxy({}, { get: () => () => {} });
    try {
      const effectiveTools = agent.getEffectiveTools();
      const offered = new Set(effectiveTools.map((tool) => tool.function.name));
      assert.equal(offered.has("read_tool_output"), Boolean(mask), "id retrieval is offered only when masking is enabled");
      assert.equal(Boolean(agent.getCapabilityRegistry().getByToolName("read_tool_output")), Boolean(mask), "the handler is registered only with its opt-in tool");
      if (mask) {
        const tool = effectiveTools.find((candidate) => candidate.function.name === "read_tool_output")!;
        assert.deepEqual(tool.function.parameters.required, ["id"]);
        assert.equal(tool.function.parameters.properties.id.type, "string");
      }
      await agent.runTurn("1. Read big.txt\n2. Read small.txt\n3. Summarize");
      return gw.requests as any[];
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  test("request shape: the later request carries the mask marker, the id resolves to the full output, the ledger is intact", { timeout: 90_000 }, async () => {
    const requests = await run("100");
    assert.ok(requests.length >= 4, `${requests.length} requests`);
    const third = requests[2].messages as any[];
    const first = third.filter((m) => m.role === "tool")[0];
    assert.ok(textOf(first).startsWith(MASK_MARKER_PREFIX), "the old large result is masked");
    assert.ok(!textOf(first).includes("line 399"));
    assert.ok(textOf(requests[1].messages.filter((m: any) => m.role === "tool")[0]).includes("line 399"), "a result the model has not acted on yet is sent whole");
    assert.ok(third.some((m) => m.role === "system" && textOf(m).startsWith(PINNED_LEDGER_PREFIX)), "the pinned ledger is not masked");
    const retrieved = (requests[3].messages as any[]).filter((m) => m.role === "tool").map(textOf).find((t) => t.includes("line 399"));
    assert.ok(retrieved && retrieved.includes("line 0 of the big output"), "read_tool_output returned the full output by id");
    assert.equal(textOf((requests[3].messages as any[]).filter((m) => m.role === "tool")[0]).startsWith(MASK_MARKER_PREFIX), true);
  });

  test("default (unset): no request carries a marker and the old output is resent whole", { timeout: 90_000 }, async () => {
    const requests = await run(undefined);
    for (const r of requests.slice(0, 3)) assert.ok(!JSON.stringify(r.messages).includes(MASK_MARKER_PREFIX));
    assert.ok(JSON.stringify(requests[2].messages).includes("line 399"));
    assert.ok(!JSON.stringify(requests[2].tools).includes("read_tool_output"));
  });
});
