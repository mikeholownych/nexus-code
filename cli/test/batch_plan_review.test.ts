import assert from "node:assert/strict";
import test from "node:test";
import { selectBatchPlanReviewer } from "../src/batch_plan_review.js";
import type { ResourceDescriptor } from "../src/core/resources.js";

const descriptor = (id: string, model: string, extra: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({
  id,
  model,
  provider: "fixture",
  endpoint: "http://127.0.0.1",
  capabilities: [],
  contextLength: 4096,
  ...extra,
});

test("review selection requires distinct qualified context-fitting resources and prefers local", () => {
  const planner = { resourceId: "primary", model: "writer", disclosure: "local" } as const;
  const one = descriptor("primary", "another");
  const alias = descriptor("alternate-endpoint", "WRITER");
  const narrow = descriptor("narrow", "narrow-model", { contextLength: 512 });
  const unqualified = descriptor("unqualified", "unqualified-model", { qualifications: ["write"] });
  const local = descriptor("reviewer", "review-model", { rank: 99, qualifications: ["review"] });
  const cloud = descriptor("cloud", "cloud-model", { rank: 0, qualifications: ["review"] });
  const disclosure = (resource: ResourceDescriptor) => resource.id === "cloud" ? "cloud" : "local";
  const alternatives = [one, alias, narrow, unqualified, cloud];
  assert.equal(selectBatchPlanReviewer([...alternatives, local], planner, disclosure, { allowCloud: true, minContext: 1024 }), local);
  assert.equal(selectBatchPlanReviewer(alternatives, planner, disclosure, { allowCloud: false, minContext: 1024 }), undefined);
  assert.equal(selectBatchPlanReviewer(alternatives, planner, disclosure, { allowCloud: true, minContext: 1024 }), cloud);
});

test("review selection rejects the effective planner model even when it was requested under an alias", () => {
  const planner = { resourceId: "primary", model: "writing-alias", effectiveModel: "base-model", disclosure: "local" } as const;
  const same = descriptor("reviewer", "BASE-MODEL");
  assert.equal(selectBatchPlanReviewer([same], planner, () => "local", { allowCloud: false }), undefined);
});
