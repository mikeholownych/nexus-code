# Command hooks

A hook is a program Nexus runs before (`pre-tool`) or after (`post-tool`) a tool call. A pre-tool hook can refuse the
call; no hook can approve one. The contract is in [`docs/HOOKS.md`](../../docs/HOOKS.md).

- `hooks.json` is an operator hooks file (it belongs in `~/.config/nexus/hooks.json`): one pre-tool hook for
  `run_command`.
- `deny-force-push.sh` is that hook: it refuses `git push --force`.
- `run.sh` installs both into a throwaway `HOME` and tries the hook against two sample calls with
  `nexus hooks test`. It needs no model and runs no tool.

```console
$ ./run.sh
operator  /tmp/tmp.XXXX/.config/nexus/hooks.json  active  sha256 …
  pre-tool  no-force-push  tools: run_command  timeout: 10s
…
--- a forced push: the hook denies it
  operator  no-force-push  deny  exit 2  force pushes are not allowed from an agent session: push without --force, or ask the operator
decision: DENY (HOOK_DENIED) [hook no-force-push (operator)] force pushes are not allowed from an agent session: push without --force, or ask the operator
denied, as it should be (exit status 2)
```

To use it for real, copy the script to `~/.config/nexus/hooks/` and `hooks.json` to `~/.config/nexus/hooks.json`
(mode 600), then check with `nexus hooks list`.
