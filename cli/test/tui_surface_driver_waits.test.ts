/**
 * The PTY surface driver (test/helpers/tui_surface_driver.py) waits for what it is about to assert on, not for a
 * proxy of it. A frame reaches the pseudo-terminal cell by cell from the top row down, so a panel's title can be on
 * screen while its decisions and their hint are still in flight; a driver that stopped waiting at the title and read
 * the hint a fixed moment later failed once in CI (ci.yml run 42407452307, `not ok 1171`: "keys typed just before the
 * panel disarm its letters, and the panel says so"). These checks feed the driver's wait predicate real screens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(here, "helpers");

/** Asks the driver module whether each screen shows the approval panel wholly. */
function approvalPanelShown(screens: string[][]): boolean[] {
  const code = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(HELPERS)})`,
    "import tui_surface_driver as driver",
    "print(json.dumps([driver.approval_panel_shown(screen) for screen in json.load(sys.stdin)]))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-I", "-c", code], { input: JSON.stringify(screens), encoding: "utf8" }).trim());
}

const pad = (rows: string[], height: number) => rows.concat(Array(Math.max(0, height - rows.length)).fill(""));

// The screen before the panel: the transcript of the previous turn, the idle hint and an empty composer (120x36).
const BEFORE = pad(
  [
    " NEXUS   nexus-sidecar-mSZFA1  ⎇ master ●2 changed  model m  mode: review · sandbox: off · workspace: trusted",
    "    ▎   3 + }",
    "",
    "Added src/cache.ts. The read of missing.txt failed because the file does not exist.",
    "",
    "! Done · not verified  Files changed, but no verifier ran before the agent finished.",
    "  → next: run /test, or ask Nexus to verify the change · v receipt",
  ],
  34,
).concat([" enter send · shift+enter newline · ? help ───────────────────────────────────────────────", "› ask Nexus · / for commands · ? for keys"]);

// The frame that shows the approval panel, as the driver captured it on a run that passed.
const PANEL = [
  "╭ Approval needed ─────────────────────────────────────────────────────────────────────────────────────────────────────╮",
  "│Write config.json                                                                                                     │",
  "│Proposed: create config.json · +1 −0                                                                                  │",
  "│                                                                                                                      │",
  "│ ▎ @@ −0,0 +1,1 @@                                                                                                    │",
  "│ ▎   1 + { \"cache\": true }                                                                                            │",
  "│                                                                                                                      │",
  "│ Approve   Approve all later actions   Deny                                                                           │",
  "│typing ignored · ←→ approve/deny, pause, enter · esc denies                                                           │",
  "╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯",
];
const AFTER = [BEFORE[0], ...PANEL, ...Array(23).fill(""), " approval needed · ←→ then enter (typing is ignored) · esc denies ──────────────────────────────────────────────────────", "› yyy"];

/** The screen after the frame's first `delivered` rows reached the terminal: the rest still shows the frame before. */
const halfDelivered = (delivered: number) => AFTER.slice(0, delivered).concat(BEFORE.slice(delivered));

test("the approval panel counts as shown only once its decisions and hint rows are on screen", () => {
  const screens = {
    before: BEFORE,
    titleOnly: halfDelivered(2),
    proposedButNoDecisions: halfDelivered(8),
    decisionsButNoHint: halfDelivered(9),
    hintButNoBottomBorder: halfDelivered(10),
    whole: AFTER,
  };
  const shown = Object.fromEntries(Object.keys(screens).map((k, i) => [k, approvalPanelShown(Object.values(screens))[i]]));
  assert.deepEqual(shown, { before: false, titleOnly: false, proposedButNoDecisions: false, decisionsButNoHint: false, hintButNoBottomBorder: false, whole: true }, JSON.stringify(shown));
});

test("a panel whose letters answer it is shown too: the predicate reads structure, not one hint's wording", () => {
  const armed = AFTER.map((row) =>
    row.startsWith("│ Approve   Approve all")
      ? "│ y Approve   a Approve all later actions   n Deny                                                                     │"
      : row.startsWith("│typing ignored")
        ? "│y or n, or ←→ then enter · ↑↓ scroll the change                                                                       │"
        : row,
  );
  assert.deepEqual(approvalPanelShown([armed]), [true]);
});
