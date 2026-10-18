# Manual real-terminal matrix (ACCEPTANCE §5.3, REQ-QUAL-108)

A human runs this procedure against the **installed RC**. Automated PTY suites (§5.1, §5.2) do not replace it.

**Cells:** five terminals, each at 80×24, 40×14 and 200×60, giving 15 cells.
- xterm
- kitty, with the kitty keyboard protocol on
- tmux 3.x inside GNOME Terminal
- the VS Code integrated terminal
- GNOME Terminal

**Gate:** zero FAIL on checks 2, 5 and 6. Any other FAIL needs a written disposition.

## Before you start

1. Install the RC with the documented one-line command. `nexus --version` must print the RC version, and `nexus` must
   not resolve into a checkout.
2. Choose a new evidence directory, `OUT=docs/reviews/evidence/v1-qualification/<rc>/terminal`, and use it for every cell.
3. You need a screenshot tool, and `python3` and `git` on `PATH`. No inference is used: a local mock gateway
   (`mockgw.py`) answers every request.

## Each cell

Open the terminal and resize it to the cell's size. For tmux, start tmux inside GNOME Terminal. For kitty, enable the
keyboard protocol. Then run:

```sh
scripts/terminal-acceptance/run-cell.sh --rc <rc> --terminal <xterm|kitty|tmux-gnome|vscode|gnome> --size <WxH> --out "$OUT"
```

The script refuses to start in these cases: the wrong RC, a checkout build, the wrong size, not inside tmux for
`tmux-gnome`, or a cell already recorded. It creates an isolated HOME and workspace and starts the mock. Then it opens
the TUI twice, once normally and once with `NO_COLOR=1`, and prompts you through checks 1–7:

| # | You do | You judge |
|---|---|---|
| 1 | The TUI opens | It renders correctly at this size |
| 2 | Prompt `approve`. At each approval panel, type continuously, paste 3 lines, then approve with a deliberate key | No decision is made by the stray input, and the deliberate key decides. **Screenshot the panel.** |
| 3 | Shift+Enter or Alt+Enter while composing | It inserts a newline and does not submit |
| 4 | Prompt `stream`, then resize while it streams and restore the size | Layout recovers and nothing is garbled or lost |
| 5 | Prompt `sleep`, then press Esc while `sleep 30` runs | Cancel is acknowledged, and nothing survives |
| 6 | Press Ctrl-C twice to quit | The terminal is restored: echo on, no stray escape codes. **Screenshot the terminal after exit.** |
| 7 | Second launch, with `NO_COLOR=1` | The TUI is readable without colour |

The script also **measures** two things:
- whether `stty` state after each exit equals the state before it;
- any process started from the cell's HOME that is still running after exit.

A measured survivor fails check 5, and an unrestored terminal fails check 6, whatever you recorded. Each cell writes
`cell-<terminal>-<size>.json` with the RC version, binary path and SHA-256, terminal environment, measurements, your
results and notes, screenshot hashes, and the mock request log. A cell is recorded once. To retry, keep the failed
attempt and use a new evidence directory.

## Gate

```sh
# MANIFEST_SHA: sha256 of MANIFEST.sha256 inside the RC archive, e.g.
#   tar -xzOf nexus-linux-x86_64-<rc>.tar.gz --wildcards '*/MANIFEST.sha256' | sha256sum
node scripts/terminal-acceptance/summarize.mjs "$OUT" --rc <rc> --manifest-sha256 "$MANIFEST_SHA" [--dispositions dispositions.json]
```

The summarizer prints the 15-cell table and writes `matrix-summary.json`. **PASS** requires all of the following:
- every cell is present (a missing cell is NOT RUN);
- every attempt names the given RC, and its installed package manifest equals the archive's;
- checks 2, 5 and 6 have no FAIL;
- every other FAIL has an entry `"<cell>:<check>": "<fix or documented known limitation>"` in the dispositions file;
- every aborted attempt (a `.partial` file, which holds the measurements taken before it was abandoned) has an entry
  `"<cell>:partial-<n>"`.

The record hashes prove that files are unchanged since recording, not who recorded them. Commit the evidence directory
to the qualification evidence PR to make it authoritative.
