# Installed RC9 accessibility probe

The workflow-produced and installed RC9 package was exercised in a synthetic workspace with a local mock gateway. The candidate is source `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566`, archive SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`, installed package manifest SHA-256 `4cf1b288892891c3db6135c8bb9919e4a21e871ef2c5be5c211e39fa13bde0e6`.

## Results

| Environment | Size | Color SGR result | Visible states | Verdict |
|---|---:|---|---|---|
| `NO_COLOR=1`, `TERM=xterm-256color` | 40×14 | No foreground, background, or underline color SGR parameters | Idle; approval | PASS for this subcase |
| `NO_COLOR=1`, `TERM=xterm-256color` | 100×30 | No foreground, background, or underline color SGR parameters | Idle; approval | PASS for this subcase |
| `TERM=dumb`, `NO_COLOR` unset | 40×14 | Emits color reset SGR `39m`, `49m`, `59m` | Idle; approval | FAIL |
| `TERM=dumb`, `NO_COLOR` unset | 100×30 | Emits color reset SGR `39m`, `49m`, `59m` | Idle; approval | FAIL |

The monochrome screen content remained legible, and the 40×14 approval panel showed its three choices and the instruction `y or n, or ←→ then enter`. The failure is at the terminal-control boundary: the installed program emits color reset SGR commands under `TERM=dumb`, contrary to the acceptance criterion requiring zero color SGR codes. `39m`, `49m`, and `59m` reset foreground, background, and underline color; no non-default color assignments were observed in those captures.

This is partial evidence for `ACC-TUI-A11Y`, not a pass. Only idle and approval states were captured, so the full requirement that every state remain distinguishable is not established. The `TERM=dumb` failure requires source remediation, a new immutable RC, and affected installed-RC requalification.

Raw PTY streams are Base64 encoded as `*.raw.b64`; decoded `pyte` screen captures are retained as `*.screens.txt`. The capture verifier checks the recorded state and color-sequence assertions. Earlier harness attempts are retained outside this directory under `/var/tmp/nexus-rc9-a11y-probe-*`; the first detector counted all SGR (including bold/reverse attributes), one hint assertion expected the typing-disabled wording in a non-typing state, and one cancellation assertion assumed Escape returned directly to the composer. Those attempts are incomplete and are not counted as results.
