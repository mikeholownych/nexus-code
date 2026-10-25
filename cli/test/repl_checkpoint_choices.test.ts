import assert from "node:assert/strict";
import { test } from "node:test";
import { InteractiveRepl } from "../src/repl.js";
import { SensitivePersistenceError } from "../src/core/persistence_protection.js";

function makeRepl(choice: string, checkpoint: (allowSensitive: boolean) => void = () => {}): {
  repl: InteractiveRepl;
  prompts: string[];
  fallback: boolean[];
} {
  const prompts: string[] = [];
  const fallback: boolean[] = [];
  let first = true;
  const repl = Object.create(InteractiveRepl.prototype) as any;
  repl.config = { readOnly: false };
  repl.checkpointManager = {
    createCheckpoint: (_name: string, options?: { allowSensitive?: boolean }) => {
      if (first) {
        first = false;
        throw new SensitivePersistenceError("checkpoint");
      }
      checkpoint(options?.allowSensitive === true);
      return {};
    },
  };
  repl.agent = {
    setCheckpointReadOnlyFallback: (value: boolean) => fallback.push(value),
    setApprovalMode: () => {},
  };
  repl.rl = { question: async (prompt: string) => { prompts.push(prompt); return choice; } };
  return { repl, prompts, fallback };
}

test("REPL asks how to proceed when sensitive content blocks a turn checkpoint", async () => {
  for (const [choice, expectedProceed, expectedFallback, expectedSensitiveRetry] of [
    ["1", true, true, false],
    ["2", true, false, false],
    ["3", true, false, true],
    ["4", false, false, false],
    ["5", false, false, false],
  ] as const) {
    let sensitiveRetry = false;
    const { repl, prompts, fallback } = makeRepl(choice, (allowSensitive) => { sensitiveRetry = allowSensitive; });
    const proceed = await (repl as any).prepareTurnCheckpoint("Turn: protected workspace");
    assert.equal(proceed, expectedProceed, `choice ${choice} proceed disposition`);
    assert.deepEqual(prompts, ["Choice [1-5]: "]);
    assert.deepEqual(fallback, expectedFallback ? [true] : (choice === "4" || choice === "5" ? [] : [false]));
    assert.equal(sensitiveRetry, expectedSensitiveRetry, `choice ${choice} sensitive checkpoint retry`);
  }
});

test("REPL asks how to proceed when initial protected Git verification blocks a turn checkpoint", async () => {
  const { repl, prompts, fallback } = makeRepl("2");
  repl.checkpointManager.createCheckpoint = () => {
    throw new Error("Checkpoint could not verify protected Git state; no checkpoint was written");
  };

  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: protected workspace"), true);
  assert.deepEqual(prompts, ["Choice [1-5]: "], "the user must choose how to proceed before the turn starts");
  assert.deepEqual(fallback, [false], "continuing without a checkpoint preserves the configured permission mode");
});

test("REPL asks again when the acknowledged checkpoint attempt fails protected Git verification", async () => {
  const { repl, prompts, fallback } = makeRepl("3", (allowSensitive) => {
    if (allowSensitive) throw new Error("Checkpoint could not verify protected Git state; no checkpoint was written");
  });
  const answers = ["3", "2"];
  repl.rl.question = async (prompt: string) => {
    prompts.push(prompt);
    return answers.shift()!;
  };

  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: protected workspace"), true);
  assert.deepEqual(prompts, ["Choice [1-5]: ", "Choice [1-5]: "], "the second checkpoint failure must ask before starting the turn");
  assert.deepEqual(fallback, [false], "continuing without a checkpoint preserves the configured permission mode");
});

test("REPL re-prompts for an invalid choice instead of silently choosing a mode", async () => {
  const { repl, prompts } = makeRepl("2");
  const answers = ["unexpected", "2"];
  repl.rl.question = async (prompt: string) => { prompts.push(prompt); return answers.shift()!; };
  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: protected workspace"), true);
  assert.deepEqual(prompts, ["Choice [1-5]: ", "Choice [1-5]: "]);
});

test("REPL does not request a checkpoint for an explicitly read-only launch", async () => {
  const { repl, prompts, fallback } = makeRepl("1");
  repl.config.readOnly = true;
  let checkpointCalls = 0;
  repl.checkpointManager.createCheckpoint = () => { checkpointCalls++; };
  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: read-only"), true);
  assert.equal(checkpointCalls, 0);
  assert.deepEqual(prompts, []);
  assert.deepEqual(fallback, [false]);
});

test("REPL uses read-only for the current turn and resumes after a later safe checkpoint", async () => {
  const { repl, fallback } = makeRepl("1");
  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: sensitive workspace"), true);
  assert.deepEqual(fallback, [true]);

  let checkpointsAfterChoice = 0;
  repl.checkpointManager.createCheckpoint = () => { checkpointsAfterChoice++; };
  assert.equal(await (repl as any).prepareTurnCheckpoint("Turn: later instruction"), true);
  assert.equal(checkpointsAfterChoice, 1, "the later turn starts only after its safe checkpoint succeeds");
  assert.deepEqual(fallback, [true, false], "configured mode resumes only after the successful checkpoint");
});
