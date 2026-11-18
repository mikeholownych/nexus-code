# Skills Architecture — Threat Model

**Baseline:** `3c54e6014c2ea5281f642fdd53ac20605f2b24ae`  
**Companion:** `SKILLS_ARCHITECTURE_AUDIT.md`

---

## 1. Assets

| Asset | Sensitivity |
|---|---|
| Workspace files | High |
| Host shell / process | Critical |
| Credentials under `~/.config/nexus`, env, vault | Critical |
| Session / task state and receipts | High (integrity, privacy) |
| Skill catalog influencing model selection | Medium |
| Skill bodies injected into context | Medium (integrity of advice) |
| Operator trust decisions (workspace trust, approvals) | High |

---

## 2. Actors

| Actor | Capability |
|---|---|
| Operator | Installs skills, trusts workspace, sets mode/`--yes`, answers approvals |
| Local model / provider | Chooses tools; may follow skill text |
| Skill author / installer | Writes SKILL.md into global or workspace dirs |
| Malicious workspace contributor | Can plant skills under `.agents/skills` if workspace trusted |
| Compromised symlink target | Controls content read through a trusted path |
| MCP / plugin author | Separate path; can register executable tools |
| Subagent | Inherits parent session tools/authority with role constraints |

---

## 3. Trust boundaries

```
[Disk skill files] --load--> [SkillManager memory]
        |                         |
        | catalog/note (sanitized descriptions)
        v                         v
[System prompt / user notes] --> [Model]
                                    |
                              tool calls
                                    v
[dispatch_tool_call] --> [ApprovalPolicy] --> [ExecutionSpine]
                                                    |
                                    authority + confinement + egress
                                                    v
                                              [Handlers / host]
```

Distinct boundaries (must not be conflated):

1. **Install/discovery trust** — which directories load as trusted.
2. **Prompt trust** — text entering the model (sanitized descriptions vs raw bodies).
3. **Execution authority** — which tools/args may run.
4. **Evidence trust** — durable records of what ran.

Prompt sanitization is **not** an execution security boundary.

---

## 4. Entry points

- Global skill dirs (`~/.nexus/skills`, `~/.agents/skills`, `~/.claude/skills`, …)
- Workspace skill dirs (trust-gated)
- Symlinked skill trees
- `activate_skill` tool
- Per-prompt skill notes + system catalog
- Slash `/skills`, `/skill`
- Watcher-driven `refresh`
- Session restore of messages containing activations / notes

---

## 5. Authorization boundaries (actual)

Enforced today:

- Workspace trust for workspace skill activation
- Approval mode (review / auto / read-only) by effect class
- `fullAccess` / `--yes` (operator-authorized widening)
- Explicit grants when configured (else default workspace admit)
- Role tool allow-lists
- Resource confinement for path-like tool args (not shell operand parsing)
- RO safe-command allowlist
- Untrusted workspace skill hard deny
- Headless needs_input ids bound to tool+args

Not enforced today:

- Per-skill capability allowlists from frontmatter
- Skill content digest binding on receipts
- Publisher / signature checks
- Skill-scoped revocation mid-task
- `isUntrustedSource` on live `activate_skill` path

---

## 6. Attack paths

| Path | Preconditions | Outcome today | Residual risk |
|---|---|---|---|
| Malicious global skill | Operator installs / syncs hostile SKILL.md | Instructions enter context on activate; tools still session-gated | High influence on model under auto/`--yes` |
| Symlink to hostile tree | Link under global skills dir | Content trusted as global (ADV-06) | Supply-chain |
| Untrusted workspace skill | No `nexus trust` | Activation denied | Low |
| Trusted workspace + malicious skill | Operator trusted workspace | Activates; session policy applies | Same as any trusted project code |
| Frontmatter `allowed-tools` | Any | Ignored; no expansion | None for expansion; no restriction either |
| Skill body prompt forge | Markers in body | Injected raw on activate (ADV-04) | Model confusion; not auth grant |
| Skill instructs shell escape | Permissive session | Shell may mutate outside path jail | Session/sandbox dependent |
| Post-activate file swap | Watcher/refresh | New activate sees new body; old text remains in messages | Forensics / TOCTOU |
| Impersonate skill via note text | Operator pastes note | Provenance rules reduce false notes | Medium social |

---

## 7. Existing controls (compensating)

- Documented model: skills are untrusted instructions (`SKILLS_AND_PLUGINS.md`)
- Description/catalog sanitization (`oneLine`, `TEMPLATE_TOKEN`, `CONTROL_MARKER`)
- Injection scanner + fencing for tool results (CS-7)
- Execution spine + receipts for tools
- Workspace trust + plugin dir policy (plugins stricter than skills in some dirs)
- Sandbox options (when enabled; not re-qualified here)

---

## 8. Residual risks

1. Global skill install = trust content with agent authority under chosen mode.
2. Shell remains a broad effect class relative to path confinement.
3. Weak skill-to-tool forensic linkage.
4. No qualification gate before advertising/activating skills.
5. Dead `isUntrustedSource` wiring may confuse future designers into believing activate is gated for “untrusted sources.”

---

## 9. Deployment assumptions

| Profile | Assumption |
|---|---|
| Single-user workstation | Operator controls HOME skill installs; Medium findings often acceptable |
| Shared HOME / multi-agent host | Global skills are a shared trust root — elevate F-04 |
| CI / headless | Review mode fails closed without operator; `--yes` is explicit |
| Air-gapped | No remote skill registry required; local-first preserved |
| Auto / fullAccess dogfood | Skills amplify instruction risk; prefer review for untrusted skill packs |
