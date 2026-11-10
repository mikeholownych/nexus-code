# D-03 captures

Driven with the audit harness (`docs/v1.1.4/tui-audit-harness/` on `origin/v1/v114-tui-audit`): fake OpenAI-compatible
server, isolated HOME/state, throwaway repo from `setup.sh trust`, tmux 120x40, `nexus --live --mode review`.

- `before/` is `origin/main` bef88219; `after/` is this branch.
- `fresh-repo-hello.txt`: the pane after sending `hello`, then `/git`, then `/diff`. Before: header `●1 changed`, `/git` prints
  `?? .nexus/`. After: no count, `/git` says the tree is clean.
- `user-git-status.txt`: the user's own `git status --porcelain` in the workspace afterwards. Before `?? .nexus/`; after empty
  (`.nexus/.gitignore` is written next to the receipts).
- `after/user-change.txt`: `base.txt` edited before starting. The header counts it once (`●1 changed`), and `/git` lists only
  ` M base.txt`.
