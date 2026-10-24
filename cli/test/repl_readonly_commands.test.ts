import { test } from "node:test";
import assert from "node:assert/strict";
import { replReadOnlyAllowed } from "../src/repl.js";

test("explicit read-only REPL allows inspection but refuses mutating slash commands", () => {
  for (const [command, args] of [
    ["status", ""], ["diff", ""], ["git", "status"], ["checkpoints", ""], ["sessions", ""],
    ["mode", "auto"], ["history", ""], ["skills", ""], ["skill", "reviewer"], ["theme", ""],
    ["doctor", "--deep"], ["checkpoint", "diff"], ["worktree", "status"], ["knowledge", ""],
    ["plan", ""], ["exit", ""],
  ]) {
    assert.equal(replReadOnlyAllowed(command, args), true, `/${command} ${args} should stay available`);
  }

  for (const [command, args] of [
    ["init", ""], ["skill", "init leaked"], ["mcp", "add"], ["commit", "msg"], ["upgrade", ""],
    ["stage", "."], ["save", ""], ["export", "out.md"], ["worktree", "add x"], ["knowledge", "set k v"],
    ["theme", "dark"], ["doctor", "--fix"], ["plan", "set"], ["model", "x"], ["test", ""],
    ["compact", ""], ["onboard", ""], ["undo", ""],
  ]) {
    assert.equal(replReadOnlyAllowed(command, args), false, `/${command} ${args} must be refused`);
  }
});
