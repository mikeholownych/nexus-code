# D-21 captures

`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-21 before|after <nexus-tui binary> 69067429`. The real
`promptWorkspaceTrust` (tsx, in a pty of 100, 60 and 40 columns) for a folder with an `AGENTS.md` and a long path; `before`
loads the integration branch's `startup_trust.ts` (`git show 69067429:cli/src/startup_trust.ts`). The binary argument is unused
here (the prompt is TypeScript); it stays so the three captures share one command line.

- `before.txt`: the copy hard-wrapped at about 40 columns at any width ("Trust loads project instructions and / workspace
  integrations."), the path cut with a leading ellipsis, the key hint above the question.
- `after.txt`: sentences wrapped at the terminal width on word boundaries, the path whole (broken after a `/` first), the same
  three choices and keys, the key hint under the choices.

Limit: this is the same inline prompt, restyled in copy and layout. Moving it into the Ratatui UI (a welcome frame, one look)
is a larger change this fix does not make; the audit's "welcome shows only `workspace: untrusted`" part is not changed here.
