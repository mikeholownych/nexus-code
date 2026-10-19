import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session.js";
import { InformationFlowBoundary } from "../src/core/egress.js";

describe("session id generation", () => {
  const generate = SessionManager.prototype.generateSessionId;

  it("keeps the documented identifier shape within the egress whitelist", () => {
    const id = generate.call({} as any);
    assert.match(id, /^session_\d{8}_\d{6}_[a-z0-9]{1,8}$/);
    assert.match(id, /_[a-z0-9]{8}$/, "suffix must use the full unpredictable width");
  });

  it("stays unique across many generations under a frozen clock", () => {
    const RealDate = Date;
    const frozen = new RealDate(2026, 9, 19, 12, 34, 56);
    (globalThis as any).Date = class extends RealDate {
      constructor() {
        super(frozen.getTime());
      }
    };
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 10_000; i++) seen.add(generate.call({} as any));
      // With the frozen clock only the random suffix can distinguish ids: the
      // previous 4-character Math.random suffix collided within this budget.
      assert.equal(seen.size, 10_000);
    } finally {
      (globalThis as any).Date = RealDate;
    }
  });

  it("is never classified as a secret by the information flow boundary", () => {
    const boundary = new InformationFlowBoundary();
    for (let i = 0; i < 1_000; i++) {
      const id = generate.call({} as any);
      assert.deepEqual(boundary.classifyText(id), [], id);
    }
  });
});
