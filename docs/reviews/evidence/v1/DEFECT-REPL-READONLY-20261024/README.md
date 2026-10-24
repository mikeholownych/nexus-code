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

Add `replReadOnlyAllowed(command, args)` and guard the slash dispatch when `config.readOnly` is set **or** the
agent’s effective mode is `read-only` (so `/mode read-only` in an otherwise writable session is gated too). The
allowlist is conservative and default-deny: inspection/navigation (`help`/`?`, `status`, `diff`, `git`,
`checkpoints`, `history`, `skills`, `mode`, `copy`, `paste`, `image`, `cd`, …), `checkpoint diff`, `worktree status`,
read-only `doctor`, non-mutating `plan`/`knowledge`, viewing a skill, and the bare `theme` command remain available.
Scaffolding, every `/mcp` form (including read-only ones: MCP initialization starts configured servers), commits,
upgrades, staging, saves/exports, model/shell changes, test execution, checkpoints and every `--fix`/`--fix=…`
doctor form are refused. `/mode auto` is allowed; in an explicit `--read-only` launch it cannot lower the agent’s read-only authority
(PR #203). A mode-selected read-only session can deliberately leave that mode with `/mode auto` or `/mode review`,
matching the sidecar.

## Verification

- New PTY regressions (`cli/test/repl_readonly_e2e.test.ts`): the explicit `--read-only` scenario fails on the base
  source with `read-only REPL must not scaffold a skill`; the `/mode read-only` scenario fails with
  `a /mode read-only session must not scaffold project instructions`. Both pass after. The first runs `/mode auto`,
  `/skill init leaked` and `/init` and confirms neither file exists; the second selects read-only at runtime and
  confirms `/init` writes nothing.
- New allowlist table (`cli/test/repl_readonly_commands.test.ts`) covers safe inspection (including `?`,
  `doctor --deep --yes`), case variants (`INIT`), MCP/upgrade forms that stay refused, and both `--fix` spellings.
- `npx tsc --noEmit`; `git diff --check`: pass.
- `repl_approval_e2e.test.ts` is left unchanged; the pre-existing approval scenarios are timing-sensitive in this
  environment and are not used as the gate for this slice.

## Residual risk

- The allowlist is a policy list, not a capability proof: a future REPL command is refused by default until it is
  reviewed and added, which is the intended fail-closed direction but may surprise users of a new safe command.
  Safe inspections that also start or discover services (`/mcp`, `/plugins`, model discovery, `/upgrade --check`)
  remain blocked deliberately, as does bare `/stage` hunk listing; a later read-only-only implementation can widen
  this.
- `/doctor --deep` is allowed (read-only analysis); every `--fix` form is refused. Other command-specific side
  effects should be re-reviewed when a command is added.
- `/cd` is pre-existing and not read-only-specific: a nonexistent path can raise, and changing workspace constructs
  managers that write under `~/.nexus` and `.git/info/exclude`.
- The sidecar already had its own allowlist; this change does not unify the two lists. A shared list would reduce
  drift but is a larger refactor.
