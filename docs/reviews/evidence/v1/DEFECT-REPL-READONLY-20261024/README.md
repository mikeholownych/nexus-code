# DEFECT: explicit `--read-only` REPL still ran mutating slash commands

| | |
|---|---|
| Base revision | `c1b13327edf5d3a0c82fb10eb814775fd4953a63` (`origin/main`) |
| Branch | `v1/defect-repl-readonly` |
| Affected behavior | The REPL’s slash dispatch had no read-only gate. `--read-only` blocked the agent’s file/command tools through the authority layer, but `/init` called `scaffoldProjectRules` and `/skill init` called `scaffoldSkill` directly; both wrote to the workspace. `/mcp add`, `/commit`, `/upgrade`, `/stage`, `/save`, `/export`, `/knowledge set`, `/theme <name>`, `doctor --fix`, `/plan` mutations and checkpoint mutations had the same shape. This is the REPL surface of the read-only promise (the TUI sidecar already had an allowlist). |
| Severity | Medium: a read-only session is the safe inspection posture for an untrusted workspace; direct slash scaffolding bypasses it without any model/tool involvement. |

## Reproduction (pre-fix)

PTY probe (`nexus repl --read-only` in a trusted temporary repo):

```
/mode auto
/skill init leaked
/init
```

Pre-fix: `.nexus/skills/leaked/SKILL.md` and `AGENTS.md` both existed, and the new PTY regression failed with
`read-only REPL must not scaffold a skill`.

The pure allowlist test also covers the command matrix once the helper exists; the PTY test is the pre-fix
regression because the helper did not exist before this change.

## Fix

Add `replReadOnlyAllowed(command, args)` and guard the slash dispatch when `config.readOnly` is set. The allowlist is
conservative and default-deny: inspection/navigation (`status`, `diff`, `git`, `checkpoints`, `history`, `skills`,
`mode`, `copy`, `paste`, `image`, `cd`, …), `checkpoint diff`, `worktree status`, read-only `doctor`, non-mutating
`plan`/`requirements`/`knowledge`, viewing a skill, and the bare `theme` command remain available. Scaffolding,
MCP additions, commits, upgrades, staging, saves/exports, model/shell changes, test execution, checkpoints and
`doctor --fix` are refused. `/mode auto` is allowed but cannot lower the agent’s read-only authority (PR #203).

## Verification

- New PTY regression (`cli/test/repl_readonly_e2e.test.ts`): fails on the base source with
  `read-only REPL must not scaffold a skill`; passes after. It runs `/mode auto`, `/skill init leaked` and `/init`
  and confirms neither file exists.
- New allowlist table (`cli/test/repl_readonly_commands.test.ts`) covers 16 allowed and 18 refused command/argument
  pairs.
- `npx tsc --noEmit`; `git diff --check`: pass.
- `repl_approval_e2e.test.ts` is left unchanged; the pre-existing approval scenarios are timing-sensitive in this
  environment and are not used as the gate for this slice.

## Residual risk

- The allowlist is a policy list, not a capability proof: a future REPL command is refused by default until it is
  reviewed and added, which is the intended fail-closed direction but may surprise users of a new safe command.
- `/doctor --deep` is allowed (read-only analysis); `/doctor --fix` is refused. Other command-specific side effects
  should be re-reviewed when a command is added.
- The sidecar already had its own allowlist; this change does not unify the two lists. A shared list would reduce
  drift but is a larger refactor.
