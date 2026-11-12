import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { OSC52_MAX_BYTES, copyWithFallback, osc52Enabled, osc52Sequence } from "../src/clipboard.js";
import { formatSafeSidecarEvent } from "../src/sidecar.js";
import { ApplicationCore } from "../src/core/app.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { SlashHost } from "../src/slash/catalog.js";
import { routeSlash } from "../src/slash/router.js";
import { receiptSections } from "../src/evidence.js";
import { makeHome, makeRepo } from "./helpers/fixtures.js";

/** Runs `fn` with a PATH that holds no clipboard tool, so the real system clipboard is never touched. */
function withoutClipboardTools<T>(fn: () => T): T {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-nobin-"));
  const previous = process.env.PATH;
  process.env.PATH = empty;
  try {
    return fn();
  } finally {
    process.env.PATH = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

describe("D-16: OSC 52 clipboard fallback", () => {
  test("the sequence carries the text only as base64, so no byte of it can reach the terminal as control input", () => {
    const hostile = "before\x1b]0;owned\x07\x1b[2J\x9b31m‮ after\nline two \u{1F600}";
    const seq = osc52Sequence(hostile);
    assert.match(seq, /^\x1b\]52;c;[A-Za-z0-9+/]*={0,2}\x07$/, "ESC ] 52 ; c ; <base64> BEL and nothing else");
    const payload = seq.slice("\x1b]52;c;".length, -1);
    assert.equal(Buffer.from(payload, "base64").toString("utf8"), hostile, "round-trips");
    assert.equal([...seq].filter((c) => c === "\x1b" || c === "\x07" || c === "\x9b").length, 2, "only the framing ESC and BEL");
  });

  test("it is on by default and the env switch turns it off", () => {
    assert.equal(osc52Enabled({}), true);
    for (const off of ["off", "0", "false", "no", "none", " OFF "]) assert.equal(osc52Enabled({ NEXUS_OSC52: off }), false, off);
    assert.equal(osc52Enabled({ NEXUS_OSC52: "on" }), true);
  });

  test("with no clipboard tool, a copy falls back to OSC 52; with the switch off or a too-large text it reports why", () => {
    withoutClipboardTools(() => {
      const ok = copyWithFallback("hello", {});
      assert.equal(ok.success, true);
      assert.equal(ok.osc52, "hello");
      const off = copyWithFallback("hello", { NEXUS_OSC52: "off" });
      assert.equal(off.success, false);
      assert.equal(off.osc52, undefined);
      assert.match(off.error ?? "", /No supported clipboard tool found.*NEXUS_OSC52/s);
      const big = copyWithFallback("x".repeat(OSC52_MAX_BYTES + 1), {});
      assert.equal(big.success, false);
      assert.match(big.error ?? "", new RegExp(`${OSC52_MAX_BYTES + 1} bytes.*${OSC52_MAX_BYTES}`, "s"));
      const edge = copyWithFallback("x".repeat(OSC52_MAX_BYTES), {});
      assert.equal(edge.success, true);
      // The limit is in bytes, not characters.
      assert.equal(copyWithFallback("é".repeat(Math.floor(OSC52_MAX_BYTES / 2) + 1), {}).success, false);
    });
  });

  test("/copy without a clipboard tool asks the terminal through the slash.result clipboard field and says what it did", async () => {
    const home = makeHome();
    const repo = makeRepo();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash" } as any);
    const checkpoints = new CheckpointManager(repo);
    const host: SlashHost = {
      app,
      mode: () => "auto",
      setMode: () => undefined,
      sessionId: () => "s",
      setSessionId: () => undefined,
      checkpoints: () => checkpoints,
      setWorkspace: () => undefined,
      saveSession: () => undefined,
      resumeSession: () => ({ ok: false, message: "no" }),
      history: () => [],
      confirm: () => undefined,
      receipt: () => receiptSections(null, null),
    };
    try {
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\x1b[2J line\n");
      const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-nobin-"));
      const previousPath = process.env.PATH;
      // Only git is reachable: `/copy diff` needs it, and no clipboard tool lives next to it.
      fs.symlinkSync(execSync("command -v git", { encoding: "utf8" }).trim(), path.join(emptyBin, "git"));
      process.env.PATH = emptyBin;
      let outcome: any;
      try {
        outcome = await routeSlash(host, "copy", "diff", new AbortController().signal);
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(emptyBin, { recursive: true, force: true });
      }
      assert.equal(outcome.kind, "reply");
      assert.equal(outcome.success, true, outcome.output);
      assert.match(outcome.clipboard, /\+changed\x1b\[2J line/, "the raw text travels in the field (the sidecar's boundary and the TUI sanitise it)");
      assert.doesNotMatch(outcome.output, /\x1b/, "the message itself holds no raw text");
      assert.match(outcome.output, /No clipboard tool was found/);
      assert.match(outcome.output, /OSC 52/);
      assert.match(outcome.output, /cannot confirm|does not confirm/);
      assert.match(outcome.output, /set-clipboard/);
      assert.match(outcome.output, /NEXUS_OSC52=off/);
      assert.doesNotMatch(outcome.output, /^Copied/, "it never claims the text was copied");
      const projected: any = formatSafeSidecarEvent({ type: "slash.result", id: "i", command: "copy", success: true, output: outcome.output, clipboard: outcome.clipboard } as any);
      assert.equal(typeof projected.clipboard, "string");
      assert.doesNotMatch(projected.clipboard, /\x1b/, "the boundary makes control characters visible before the TUI sees them");
    } finally {
      app.shutdown();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
