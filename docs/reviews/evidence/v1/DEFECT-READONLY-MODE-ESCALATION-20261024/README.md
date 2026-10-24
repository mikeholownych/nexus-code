# DEFECT: `/mode auto` lowers an explicit `--read-only` launch and unlocks mutating slash commands

| | |
|---|---|
| Base revision | `29eab4cd58051a8210b5ef66e0c9e248b2046a13` (`origin/main`) |
| Branch | `v1/defect-readonly-mode-escalation` |
| Affected behavior | With an explicit `--read-only` launch, `Agent.getApprovalMode()` returned `config.approvalMode` before checking `config.readOnly`. The TUI `/mode auto` slash command calls `setApprovalMode("auto")`, so the reported mode became `auto`; the sidecar's read-only slash gate keys on `getApprovalMode() === "read-only"`, so after `/mode auto` mutating slash commands were allowed. In the reproduction, `/skill init leaked` then wrote `.nexus/skills/leaked/SKILL.md` and returned success, despite the session being launched read-only. |
| Severity | Medium: a read-only session is meant to be a safe inspection posture for untrusted workspaces; this lets the operator (or a misleading UI) unlock writes, MCP server startup, theme/knowledge/skill scaffolding without leaving the session. |

## Reproduction (pre-fix)

Sidecar probe with `ApplicationCore({ readOnly: true, approvalMode: "read-only" })`:

```
MODE_AFTER= auto
MODE_OUTPUT= Mode: auto. Edits and commands run without asking.
SKILL_RESULT= {"type":"slash.result","id":"skill-1","command":"skill","success":true,
              "output":"Scaffolded leaked at /tmp/.../.nexus/skills/leaked/SKILL.md"}
SKILL_WROTE= true
```

The new regression test fails on the base source at the read-only assertion (actual `auto`, expected
`read-only`).

## Fix

`getApprovalMode()` now checks the immutable restrictions first:

```ts
if (this.checkpointReadOnlyFallback || this.config.readOnly) return "read-only";
if (this.config.approvalMode) return this.config.approvalMode;
```

The checkpoint read-only fallback was already authoritative; an explicit `--read-only` launch now is too, so a later
mode change cannot lower it. The sidecar's existing slash gate and session-state reporting therefore stay read-only,
and `/mode auto` reports the queued behaviour instead of claiming auto.

## Verification

- New `cli/test/readonly_mode_escalation.test.ts`: fails on the pre-fix source (`actual: auto`, expected
  `read-only`); passes after. It also drives `/skill init leaked` and asserts the result is refused and no
  `SKILL.md` was written.
- `approval_policy.test.ts` 13/13 and `readonly_home.test.ts` 5/5 in isolated HOME.
- `npx tsc --noEmit` clean; `git diff --check` clean.
- The full sidecar suite is timing-sensitive in this environment: it has unrelated failures on the base source as
  well (approval-timing/evidence tests), so it is not cited as a gate for this slice.

## Residual risk

- The REPL keeps a separate `approvalMode` field; `/mode auto` there still prints auto, although the agent-level
  read-only mode now remains authoritative and the tool/authority layers still reject mutations. A follow-up can
  align the REPL's displayed mode and queued-checkpoint wording.
- `checkpointReadOnlyFallback` intentionally lifts after a safe checkpoint; the test documents that behaviour and
  this change preserves it.
