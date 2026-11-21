# Operator command rules

Command rules let you decide, once, how Nexus treats a shell command the model asks to run: **allow** it without asking,
**prompt** before running it, or **forbid** it. They reduce prompt fatigue in review mode without removing review, and they
let you refuse commands you never want run. The shape follows the data-not-code command policy in Codex's `execpolicy`.

Rules live in `~/.config/nexus/command_rules.json`. **Only your home is read**: a rules file in a project is ignored, because a
repository must not be able to loosen how its own agent is approved.

```json
{
  "version": 1,
  "rules": [
    { "prefix": ["git", ["status", "log", "diff"]], "decision": "allow", "justification": "read-only git",
      "match": ["git status", "git diff --stat"], "notMatch": ["git push"] },
    { "prefix": ["git", "push"], "decision": "prompt", "justification": "pushes need a human",
      "match": ["git push origin main"] },
    { "prefix": ["rm", "-rf"], "decision": "forbidden", "justification": "never recursive-delete",
      "match": ["rm -rf build"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `prefix` | The leading words of the command. A word is a string, or a list of alternatives for that position. Matching is by whole words in order, never by substring. |
| `decision` | `allow`, `prompt` or `forbidden`. |
| `justification` | Optional short reason, shown when the rule refuses a command and recorded in the session export. |
| `match` | Example commands this rule must decide. **Checked when the file loads.** |
| `notMatch` | Example commands this rule must not decide. Checked when the file loads. |

## What each decision does

- **`allow`** removes the normal approval prompt for the command, in review mode. It changes nothing else: read-only mode,
  the sandbox, verification-file protection and the refusal to repeat a call whose outcome was unknown all still apply.
- **`prompt`** asks the operator even in auto mode. Under `--yes` it does not ask, because `--yes` already means you accepted
  prompts. With nobody to ask (headless), the command is refused with the usual "needs an operator" reason.
- **`forbidden`** refuses the command in **every** mode, including `--yes`. The model is told which rule refused it and why.
- A command no rule covers is decided exactly as before.

When several rules apply, the strictest wins: forbidden over prompt over allow.

## How a command is matched

The command is split on `;`, `&&`, `||`, `|` and `&` into parts. `prompt` and `forbidden` apply if **any** part matches, so
chaining cannot dodge them (`git status && git push` prompts). `allow` applies only if **every** part matches an allow rule,
and only if the command contains no character the shell could act on in a way this matcher does not parse: `$`, backtick,
parentheses, braces, `<`, `>`, `*`, `?`, `!`, a backslash, a newline, or a `~` or `#` that starts a word. A command with any
of those is never auto-allowed; it falls back to the normal policy. `HEAD~1` and `a#b` are ordinary words and are fine.

Rules are a convenience layer, not a sandbox. A forbidden command hidden inside `$(...)`, a script or an alias is not seen.
Use `--sandbox` for a security boundary.

## Load-time checks

Every `match` example must be decided by its own rule and with its own decision, and no `notMatch` example may be decided by
the rule. So `"match": ["git push origin main"]` on an `allow` rule is rejected if another rule prompts for `git push`, and the
error names both rules. Unknown fields, bad decisions and empty prefixes are rejected with the field path.

A file that does not load is **ignored whole** and Nexus says so once; the normal approval policy then applies. A broken file
never silently allows or forbids anything.

## What is recorded

Each time a rule changes the outcome (a prompt removed, a prompt added, or a command refused), the deciding rule is recorded
with the command (secrets redacted, at most 200 characters), the rule number, its prefix and justification. It is saved with
the session and appears in `nexus export` under `taskState.commandRuleDecisions` (JSON) and "Operator command rules"
(Markdown). Commands a rule did not affect are not listed.

Reference: openai/codex `execpolicy` (`docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md` §10). Implementation:
`cli/src/core/command_rules.ts`; tests: `cli/test/command_rules.test.ts`, `cli/test/command_rules_dispatch.test.ts`.
