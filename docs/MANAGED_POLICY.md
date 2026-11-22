# Managed policy

For the administrator of a machine or a fleet that runs Nexus.

> **Status: a library, not yet enforced.** This change adds the policy format, its parser, the merge of the tiers, the
> loader and the decision helpers as code with tests (`cli/src/core/managed_policy*.ts`). **`nexus` does not read a
> policy file yet and nothing described here changes what `nexus` does.** A policy file you install today has no
> effect. Enforcement arrives in the changes that follow (plan units GV-1 and GV-5, `docs/v1.3.0/PLAN.md`). This page
> describes what the library does when it is called, so that the format and the rules can be reviewed before anything
> depends on them. Where a later change is needed for a behaviour, the text says "planned".

## The three tiers

| Tier | File | Format | Who writes it |
|---|---|---|---|
| system | `/etc/nexus/policy.toml` | the TOML subset below | root |
| user | `~/.config/nexus/policy.toml` | the TOML subset below | the operator (or root) |
| project | `<workspace>/.nexus-security.json` | the existing JSON file | the repository |

The system path is a constant in the code. No environment variable, command-line option or setting names another
path, for either managed file. Windows has no system tier.

The system and user files are the *managed* tiers. The project file is the one Nexus already reads; its format does
not change and it needs no migration.

## Restrict-only

A policy can refuse, require a human decision, switch a convenience off, narrow an allowlist or raise a floor. It
cannot grant anything: there is no key that allows a command, trusts a workspace, enables a mode or lowers a
protection. This holds in two places.

- **In the format.** Every key restricts when it is set. `verification.mode` accepts only `"approve"` and `"block"`;
  `"off"` is a type error, not a weaker setting. `[commands]` has `forbid` and `prompt` and no `allow`.
- **In the merge.** The tiers are combined key by key with the rule in the table below: OR for switches, union for
  lists of things to refuse or protect, intersection for allowlists, the maximum for floors. With these rules a tier
  can only make the result stricter, and a tier that is absent changes nothing. Deleting the user or the project file
  therefore never takes the result below the system tier.

Precedence is **system > user > project**. Because no tier can loosen another, precedence never changes a value. It
decides *attribution*: which tier is named beside a decision.

### Example 1: a switch

System file:

```toml
schema_version = 1

[approval]
strict = true
```

User file:

```toml
schema_version = 1

[approval]
strict = false
disable_yes = false
```

Result: `strict` is true. The user file's `false` is not an override, it is the absence of a restriction. A refusal
of `--yes` is attributed to `[policy: system /etc/nexus/policy.toml approval.strict]`.

### Example 2: an allowlist

System file:

```toml
schema_version = 1

[mcp]
allow = ["github", "command:/usr/local/bin/mcp-files"]
```

User file:

```toml
schema_version = 1

[mcp]
allow = ["github", "jira"]
```

Result: only `github`. An allowlist entry survives only when every tier that sets the list has that same entry.
`jira` is not in the system list, and the system's `command:` entry is not in the user list. A user file cannot add
a server to the system's list; it can only take servers away.

## Keys

`schema_version = 1` is required as a root key in both managed files. Everything else is optional. Unknown tables and
unknown keys are errors.

| Key | Type | Merge | Meaning |
|---|---|---|---|
| `schema_version` | whole number | none | The version of the format. This build supports `1`. |
| `approval.strict` | boolean | OR | Shorthand for the next three together. |
| `approval.disable_auto` | boolean | OR | Approval mode `auto` is unavailable, whatever asks for it (`--mode auto`, `NEXUS_APPROVAL_MODE=auto`, `/mode auto`, an "always" answer). |
| `approval.disable_yes` | boolean | OR | `-y` / `--yes` is unavailable. |
| `approval.disable_full_access` | boolean | OR | Full access is unavailable, whatever asks for it. |
| `approval.require_human` | array of `"exec"`, `"write_workspace"`, `"egress"` | union | These effects always need a human decision, also under full access. |
| `verification.mode` | `"approve"` or `"block"` | maximum (`block` > `approve`) | A floor for verification-path protection. |
| `verification.protected` | array of globs | union | More protected verification paths. |
| `commands.forbid` | array of command prefixes | union | Commands that are refused, such as `"git push"`. |
| `commands.prompt` | array of command prefixes | union | Commands that always ask, also under full access. |
| `commands.disable_allow_rules` | boolean | OR | The operator's own `allow` rules in `command_rules.json` are not used. |
| `paths.protected` | array of path patterns | union | More protected paths. |
| `egress.inspector` | `"record"` or `"block"` | maximum (`block` > `record`) | A floor for the egress inspector, above `NEXUS_EGRESS_POLICY`. |
| `egress.allowed_domains` | allowlist of host names | intersection | The only hosts that may be reached: `"example.com"`, or `"*.example.com"` for its subdomains (not the name itself). |
| `egress.secret_destinations` | allowlist of origins | intersection | The only origins a credential may be sent to, such as `"https://api.example.com"`. A filter over the destinations the operator selected; it never adds one. |
| `sandbox.required` | boolean | OR | Commands run only in the sandbox; `--sandbox none` is refused. |
| `sandbox.forbid_network` | boolean | OR | Sandboxed commands get no network; `--sandbox-network` and `NEXUS_SANDBOX_NETWORK` are refused. |
| `mcp.allow` | allowlist | intersection | The only MCP servers that may start. An entry is a server name, `"command:/absolute/path"` or `"url:https://origin"`. |
| `mcp.disable_workspace` | boolean | OR | MCP servers configured by the workspace are not started. |
| `plugins.allow` | allowlist | intersection | The only plugin files that may be imported. An entry is `"sha256:<64 hex digits>"` or `"file:/absolute/path"`. |
| `plugins.disable_workspace` | boolean | OR | Plugins from the workspace are not imported. |
| `workspace.disable_env_trust` | boolean | OR | `NEXUS_TRUST_WORKSPACE` is ignored. |

Notes on the types:

- **A boolean** restricts when `true`. `false` is the same as leaving the key out.
- **An allowlist** that is absent means "unrestricted". One that is present, **even empty**, means "only these":
  `allow = []` admits nothing.
- **A command prefix** is command words separated by single spaces, at most 16. It matches a command, or any part of
  a chain (`a && b`, `a | b`), that starts with those words: `"git push"` matches `git push origin main` and not
  `git pushx`. `forbid` outranks `prompt`. A command hidden in `$(...)` or in a script is not seen; the sandbox is the
  boundary, a prefix rule is not.
- **Host names** are lowercase. **Origins** are written in canonical form: scheme, lowercase host, a port only when
  it is not the default, no path. `"https://API.example.com/"` is an error, so that the same destination is always
  the same string in every tier.
- **Paths** in `command:` and `file:` entries are absolute and normalized (no `.` or `..` segment, no doubled or
  trailing slash).
- **Duplicate items** in a list are folded into one.

A complete example:

```toml
# Fleet policy, engineering laptops.
schema_version = 1

[approval]
strict = true
# strict already implies the next three; they are written out here to show every key.
disable_auto = true
disable_yes = true
disable_full_access = true
require_human = ["egress"]

[verification]
mode = "approve"
protected = ["ci/**", "scripts/verify.sh"]

[commands]
forbid = ["git push --force", "npm publish"]
prompt = ["git push", "docker run"]
disable_allow_rules = false

[paths]
protected = [".env", "secrets/**"]

[egress]
inspector = "record"
allowed_domains = [
  "example.com",
  "*.example.com",   # subdomains
]
secret_destinations = ["https://gateway.example.com"]

[sandbox]
required = true
forbid_network = false

[mcp]
allow = [
  "command:/usr/local/bin/mcp-files",
  "url:https://mcp.example.com",
]
disable_workspace = true

[plugins]
allow = ["sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]
disable_workspace = true

[workspace]
disable_env_trust = true
```

A JSON Schema of the same data (each table an object) is published as `docs/protocol/policy-v1.schema.json` for an
editor or a linter. It describes shape only and is looser than Nexus's own validator: it does not reject unknown
keys, and it does not check the form of list items.

## The file format

A managed file is a small, strict subset of TOML.

Accepted:

- UTF-8 text with LF or CRLF line ends; blank lines; `#` comments on their own line or after a value or a table
  header;
- `key = value` lines, at the top of the file (root keys) or under a table header;
- `[table]` headers, one level deep;
- keys and table names made of lowercase letters, digits and `_`, starting with a letter;
- values: a basic string `"..."` on one line, with only the escapes `\"` and `\\`; `true` or `false`; a
  non-negative decimal whole number; an array of basic strings, which may span lines and may have a trailing comma
  and comments.

Rejected, each with the line number:

- literal strings (`'...'`), multi-line strings, any escape other than `\"` and `\\`;
- floats, signed numbers, hexadecimal, octal and binary numbers, digit separators (`1_000`), leading zeros, dates
  and times;
- inline tables (`{ ... }`), dotted keys (`a.b = 1`), quoted keys, dotted table names, arrays of tables (`[[x]]`);
- arrays of anything but strings, nested arrays;
- a key set twice in a table, a table defined twice;
- anything after a value or a table header other than a comment;
- a byte-order mark, a NUL or any control character other than tab, a carriage return that is not part of CRLF;
- a string longer than 1024 characters, an array of more than 500 items, a file larger than 64 KiB.

**Why the subset is strict.** A policy file restricts. If the reader skipped a construct it did not understand, or
took the last of two definitions of a key, a file could say one thing to the person reviewing it and another to
Nexus, and the difference would always be a missing restriction. So there is one way to write each thing, nothing is
skipped, and a file that is not understood completely is refused completely. A general TOML library would accept much
more than a policy needs; JSON was not used because the standard JSON reader silently keeps the last duplicate key.

What a rejected file looks like, and what is reported:

```text
schema_version = 1
[approval]
strict = yes            <- line 3: unsupported value 'yes': expected a "string", true, false, a whole number or an array of strings
approval.strict = true  <- dotted keys are not supported; put the key under a [table] header
mode = 'block'          <- literal strings ('...') are not supported; use a basic string "..."
```

## Fail closed

A managed file that exists must be read, checked, parsed and validated completely. If any step fails the loader
throws; it never returns a default or a partly read policy in place of a file it could not use. Only a file that does
not exist counts as "no policy in this tier".

| Condition | System tier | User tier |
|---|---|---|
| The file does not exist | tier absent | tier absent |
| `/etc/nexus` exists and is not owned by root, or is writable by group or others, or is a symbolic link, or is not a directory, or cannot be inspected | refuse (even when it holds no policy file) | not checked |
| The file is a symbolic link | refuse | refuse |
| The path is not a regular file (a directory, a FIFO, a device) | refuse | refuse |
| The file cannot be inspected, opened or read (`EACCES`, `EIO`, any other error) | refuse | refuse |
| The file is larger than 64 KiB | refuse | refuse |
| Owner | must be root (uid 0) | must be the user running Nexus, or root |
| The file is writable by group or others | refuse | refuse |
| The file changed between the first check and the open (different device or inode, or it vanished) | refuse | refuse |
| Invalid UTF-8, a byte-order mark, a NUL byte | refuse | refuse |
| A syntax error, a duplicate key or table, an unknown table or key, a wrong type, a value outside an enumeration, a malformed list item | refuse | refuse |
| An empty file (also one with comments only), or no `schema_version` | refuse | refuse |
| A `schema_version` this build does not support | refuse | refuse |

The file is opened without following a symbolic link and without blocking, and the checks of owner, mode and size
are made on the opened file. On a platform without POSIX owners the owner and mode checks do not apply.

The system tier is checked first; when both managed files are broken, the system error is the one reported.

### The error

The loader's error carries the tier, the file, a code and (for a content error) the line, and this two-line message
for stderr. The process exit code reserved for it is 2, the same as other configuration failures.

System tier:

```text
nexus: managed policy error (system tier): /etc/nexus/policy.toml: line 7: unknown key 'approval.disable_yess'.
Nexus will not start without this policy. Fix the file (root-owned; ask your administrator) and run `nexus doctor`. No setting or environment variable bypasses it.
```

User tier (the path is the real path of the file, quoted when it needs quoting):

```text
nexus: managed policy error (user tier): /home/ada/.config/nexus/policy.toml: line 4: duplicate key 'approval.strict' (first set on line 3); a key may be set once.
Nexus will not start without this policy. Fix it, or move it aside: mv /home/ada/.config/nexus/policy.toml /home/ada/.config/nexus/policy.toml.bad
```

The first line is always `nexus: managed policy error (<tier> tier): <file>: [line N: ]<what is wrong>.` The texts
for the conditions that are not about a line:

| Code | What is wrong |
|---|---|
| `directory_unsafe` | `the directory /etc/nexus is owned by uid 1000; it must be owned by root (uid 0)`; `... is writable by group or others (mode 775)`; `... is a symbolic link`; `/etc/nexus is not a directory`; `cannot inspect the directory /etc/nexus (EACCES)` |
| `symlink` | `the file is a symbolic link; it must be a regular file` |
| `not_regular` | `the path is not a regular file` |
| `unreadable` | `cannot inspect the file (EACCES)`; `cannot open the file (EACCES)`; `cannot read the file (EIO)` |
| `changed` | `the file was replaced while it was being read`; `the file was removed while it was being read` |
| `owner` | `the file is owned by uid 1000; it must be owned by root (uid 0)`; for the user tier `... it must be owned by you (uid 1000) or root` |
| `mode` | `the file is writable by group or others (mode 664); run chmod go-w on it` |
| `too_large` | `the file is larger than 64 KiB` |
| `invalid_utf8`, `bom`, `nul` | `the file is not valid UTF-8`; `the file starts with a byte-order mark; save it as UTF-8 without a BOM`; `the file contains a NUL byte` |
| `empty` | ``the file is empty; a policy file needs at least the line `schema_version = 1` `` |
| `schema_version_missing` | ``schema_version is missing; add `schema_version = 1` as the first line`` |

Content errors name the line: `syntax`, `unsupported`, `duplicate_key`, `duplicate_table`, `string_too_long`,
`array_too_long`, `control_character`, `invalid_unicode` from the parser; `unknown_table`, `unknown_key`,
`wrong_type`, `bad_value`, `schema_version_unsupported` from the validator. Examples:

```text
line 3: unknown table '[aproval]'
line 3: unknown key 'commands.allow'
line 3: key 'sandbox.required' must be true or false
line 3: key 'verification.mode' must be "approve" or "block" (found "off"); a policy can only raise this, never lower it
line 5: key 'mcp.allow', item 2 ("cmd:/x") must be a server name (letters, digits, '.', '_', '-'), "command:/absolute/path" or "url:https://origin"
line 2: schema_version 2 is not supported by this Nexus (supported: 1); upgrade Nexus before rolling out this policy
```

## Recovery

Remember the status at the top: today nothing loads a policy, so today a broken file stops nothing. What follows is
the design the enforcement changes are to implement.

- **What still runs when a tier is broken (planned):** `nexus --version`, `nexus --help`, `nexus doctor` and a
  `nexus policy check` command. Everything else exits with code 2 and the message above. `nexus doctor` does not
  report on policy files yet, and `nexus policy check` does not exist yet.
- **The system tier has no bypass.** No flag, environment variable, user setting or project file makes Nexus run
  past a system file it cannot use. The only fix is to repair or remove the file as root. This is the lockout risk
  of a managed policy: a typing mistake in a file pushed to a fleet stops Nexus on every machine that receives it.
  Until `nexus policy check` exists there is no supported command to test a file before rolling it out.
- **The user tier** fails closed too, and the user can recover alone: fix the file, or move it aside with the `mv`
  command the message prints. With the file gone the user tier is absent and the system tier still applies in full.
- **Replace a policy file atomically** (write a new file beside it, then rename). A file caught half written is
  either refused, or, if the written part happens to be a complete valid policy, read as that shorter policy.
- **`schema_version` and rollout order.** Every added or changed key bumps the version, and a reader refuses a
  version it does not know. Upgrade Nexus first, then roll out a policy that uses the new version.
- `nexus doctor --fix` is not to modify a policy file (planned).

## The project file and its integrity

`.nexus-security.json` is written by the repository, so it is treated as two parts.

- **Restrictions** (`protectedPaths`, `allowedDomains`, `verificationPaths.mode` of `approve` or `block`,
  `verificationPaths.extra`) join the merge like any tier. They apply in every workspace, trusted or not, approved or
  not. `blockedCommands` are substring patterns of the destructive-command tripwire, not command prefixes; they are
  passed through unchanged and are not turned into `commands.forbid` rules.
- **Relaxations** are the two settings that weaken verification protection: `verificationPaths.mode` of `off` or
  `record`, and `verificationPaths.allow`. They are kept apart from the merge and apply only when **all** of these
  hold:
  1. the workspace is trusted by the operator **and** the file is byte for byte the one the operator approved
     (status `MATCH`), or `NEXUS_TRUST_WORKSPACE=1` is set and no managed tier sets `workspace.disable_env_trust`
     (status `ENV_TRUSTED`);
  2. no managed tier sets any key under `[verification]`. Where a managed tier speaks about verification, the
     project's relaxations are void, in every trust state.

A project file cannot set any other key: there is no way to write `approval`, `sandbox`, `mcp`, `plugins`,
`workspace` or an egress-inspector setting from a repository.

The file's bytes are hashed (SHA-256) before anything parses them. The hash is compared with the one recorded for the
workspace in `~/.config/nexus/policy_trust.json` (mode 0600, keyed by the workspace's real path):

| Status | Meaning | Relaxations |
|---|---|---|
| `ABSENT` | no project file, none approved before | none to apply |
| `NEW` | a project file that was never approved | not applied |
| `MATCH` | the file is the approved one | applied when the workspace is also trusted |
| `MISMATCH` | the file differs from the approved one | not applied |
| `REMOVED` | a file was approved and there is none now | none to apply; reported |
| `ENV_TRUSTED` | `NEXUS_TRUST_WORKSPACE=1`, not disabled by policy | applied |
| `UNREADABLE` | the file is a symbolic link, not a regular file, larger than 64 KiB, or cannot be read | not applied; reported |

- **What is asked, and when (planned).** In an interactive session, for a trusted workspace whose file is `NEW` or
  `MISMATCH` and asks for relaxations, Nexus is to show the relaxations and ask once; a yes records the hash. A file
  that only restricts is never asked about. The library reports this state (`approvalPending`) and provides the
  function that records an approval; nothing asks yet.
- **A headless run** is never asked and never stopped by the project file. The relaxations are dropped, the
  restrictions apply, and a notice says which status caused it. The run continues tighter, not looser.
- **A project file that cannot be parsed** is not fatal, because it cannot loosen a managed tier, but it is loud:
  none of the file is used (the managed tiers and the built-in defaults still apply), and a notice says so. Today's
  reader ignores such a file silently; that changes with enforcement.
- A broken `policy_trust.json` approves nothing, and is reported.

## Decisions carry their source

Every decision the helpers return names the tier it comes from, in one form:

```text
[policy: system /etc/nexus/policy.toml approval.strict]
[policy: user /home/ada/.config/nexus/policy.toml mcp.allow]
[policy: project /work/app/.nexus-security.json verificationPaths.mode]
[policy: default]
```

For a switch or a floor, the tier named is the highest tier whose own value is the effective value. For a list, each
item carries the highest tier that lists it. For a refusal by an allowlist, the tier named is the highest tier whose
own list excludes the thing refused.

The refusal and notice texts of the admin controls (GV-5), as the helpers produce them:

```text
--yes is refused: managed policy disables it. [policy: ...]
--yes is refused: it selects approval mode 'auto', which managed policy disables. [policy: ...]
--yes is refused: it grants full access, which managed policy disables. [policy: ...]
--mode auto is refused: managed policy disables approval mode 'auto'. [policy: ...]
NEXUS_APPROVAL_MODE=auto is refused: managed policy disables approval mode 'auto'. [policy: ...]
<what asked> is refused: managed policy disables full access. [policy: ...]
/mode auto is ignored: managed policy disables approval mode 'auto'; the mode stays 'review'. [policy: ...]
'always' is not remembered: managed policy disables approval mode 'auto'; this one call is approved. [policy: ...]
approval required: managed policy requires a human decision for exec, also under full access. [policy: ...]
--sandbox none is refused: managed policy requires the sandbox. [policy: ...]
the sandbox is on (auto): managed policy requires it. [policy: ...]
--sandbox-network is refused: managed policy forbids network access in the sandbox. [policy: ...]
MCP server 'shell' is not started: it is not in the managed allowlist (mcp.allow). [policy: ...]
MCP server 'shell' is not started: managed policy disables MCP servers configured by the workspace. [policy: ...]
plugin '/ws/plugins/x.mjs' is not imported: it is not in the managed allowlist (plugins.allow). [policy: ...]
plugin '/ws/plugins/x.mjs' is not imported: managed policy disables plugins from the workspace. [policy: ...]
command refused: managed policy forbids 'git push'. [policy: ...]
approval required: managed policy asks before 'npm publish', also under full access. [policy: ...]
the egress inspector runs in 'block' mode, not 'off': managed policy sets the floor. [policy: ...]
NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. [policy: ...]
```

A flag that policy disables is to be refused at launch (exit code 2); an attempt during a session is to be clamped
with a notice and the session continues (planned; the helpers return these answers, nothing acts on them yet).

## What a policy does not protect against

- **Only the system tier is tamper-resistant.** The user file and `policy_trust.json` belong to the user. A shell
  that runs as the user outside the sandbox can edit or delete them, and the next run sees the change. Put what must
  hold in the system file, and require the sandbox there.
- **An admitted plugin runs inside the Nexus process** and can defeat any control that process applies. An entry in
  `plugins.allow` is a decision to trust that code completely; prefer `sha256:` entries, which pin the content.
- **A bare name in `mcp.allow` is spoofable.** Whoever can write an MCP configuration can give any program the name
  `github`. Pin a server with `command:/absolute/path` or `url:https://origin`.
- **A `file:` or `command:` entry trusts whatever is at that path**; protect the path with file permissions.
- **An approved project file can still relax the built-in default.** When no managed tier sets anything under
  `[verification]`, a trusted workspace whose file the operator approved may set `verificationPaths.mode` to `off`
  or `record`, as it can today. To rule that out, set `verification.mode` in a managed file.
- **Allowlists are intersected as text.** `"*.example.com"` in one tier and `"api.example.com"` in another have no
  entry in common, so the result admits nothing. That errs on the strict side, but it can surprise.
- **Command prefixes are not a sandbox** (see the note on prefixes above).
- **A valid file is taken at its word.** The checks stop a file that cannot be understood; they cannot tell a policy
  that was meant to be longer from one that is complete.
- **The published JSON Schema is looser than the validator** (see above); passing it does not mean Nexus accepts the
  file.
