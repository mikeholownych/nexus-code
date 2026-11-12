# D-11 /model picker and the endpoint the session uses

Produced by `tui_polish_capture.py` (this directory's parent) with a pseudo-terminal; `before` = `origin/v1/v114-int-4` 69067429 (TUI binary and cli built from `git archive` of that commit), `after` = the commit that fixes the defect on `v1/v114-pol-g2` (see TUI-AUDIT-STATUS.md). Command: `tui_polish_capture.py DEFECT TUI_BINARY CLI_DIR before|after OUTDIR`. Real TUI and real sidecar against a fake OpenAI server (`/v1/models` lists `fake-model`, `other-model`),
session started with `-e http://127.0.0.1:PORT/v1 -m fake-model` (a flag endpoint; the appliance default `localhost:1234` has nothing listening).
Screens at 100, 60 and 40 columns.

- `before.txt`: the picker shows only `Appliance (localhost:1234)  local · could not list models` and Connect rows; the working endpoint and current model are absent.
- `after.txt`: first group `This session (127.0.0.1:PORT)  local` with `● fake-model` (current) and `other-model`; the appliance row and Connect rows follow unchanged.
- The random port differs per run. A stray `[15;98H` fragment in one row of the after dump is an artefact of the capture's screen model (cursor addressing), not TUI output.
- Not captured in the pty: an env-configured endpoint (same code path: `config.endpoint`, no flag involved), Esc cancelling a slow list (unit proof: `closing_the_picker_while_models_are_still_being_listed_cancels_the_fetch`, `model_picker_session_endpoint.test.ts` cancel tests).
- `unit-red-before.txt`: the new TS tests before the fix.
