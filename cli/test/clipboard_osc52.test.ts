import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { OSC52_MAX_BYTES, copyWithFallback, osc52Enabled, osc52Sequence } from "../src/clipboard.js";
import { formatSafeSidecarEvent, formatSafeSidecarText } from "../src/sidecar.js";
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
      assert.equal(copyWithFallback("", {}).success, false, "an empty OSC 52 payload would clear the clipboard");
      const edge = copyWithFallback("x".repeat(OSC52_MAX_BYTES), {});
      assert.equal(edge.success, true);
      // The limit is in bytes, not characters.
      assert.equal(copyWithFallback("é".repeat(Math.floor(OSC52_MAX_BYTES / 2) + 1), {}).success, false);
    });
  });

  test("the size check applies to the sanitised text, so the reply and the TUI agree near the limit", () => {
    withoutClipboardTools(() => {
      // Each CR becomes a 3-byte glyph: 25000 CRs are 25000 bytes raw and 75000 sanitised.
      const crs = "\r".repeat(25_000);
      assert.equal(Buffer.byteLength(crs), 25_000);
      assert.ok(Buffer.byteLength(formatSafeSidecarText(crs)) > OSC52_MAX_BYTES);
      const refused = copyWithFallback(crs, {}, formatSafeSidecarText);
      assert.equal(refused.success, false);
      assert.match(refused.error ?? "", /bytes; the terminal clipboard \(OSC 52\) takes at most/);
      // Just under the limit once sanitised: accepted, and what is sent is the sanitised text.
      const fits = "\r".repeat(24_990) + "ab";
      const ok = copyWithFallback(fits, {}, formatSafeSidecarText);
      assert.equal(ok.success, true);
      assert.ok(Buffer.byteLength(ok.osc52 ?? "") <= OSC52_MAX_BYTES);
      assert.equal(ok.osc52, formatSafeSidecarText(fits));
    });
  });

  test("the sanitised copy shows a CR as its glyph and replaces credential-looking text (the stated trade-off)", () => {
    const text = formatSafeSidecarText("line one\r\nline two\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF end");
    assert.ok(text.includes("line one\u240d\nline two\n"), JSON.stringify(text));
    assert.doesNotMatch(text, /sk-ant-api03-abcdefghij/);
    assert.match(text, /REDACTED|redacted/);
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
      assert.match(outcome.clipboard, /\+changed\u241b\[2J line/, "the field already holds the sanitised text (ESC shown as its glyph); the TUI sends it only as base64");
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

test("only the exact sanitiser-failure placeholder means 'copy nothing': text that merely starts like it is copied", async () => {
  const { sanitizeForTerminal } = await import("../src/slash/workspace_commands.js");
  const { SANITIZATION_FAILED } = await import("../src/safe_text.js");
  assert.equal(sanitizeForTerminal("[diagnostic suppressed: my own note about logging]"), "[diagnostic suppressed: my own note about logging]");
  assert.equal(sanitizeForTerminal(SANITIZATION_FAILED), "", "the exact placeholder is what a failing sanitiser returns: nothing is copied");
});
