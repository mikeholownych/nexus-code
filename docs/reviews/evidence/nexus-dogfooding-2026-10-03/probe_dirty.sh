S=/tmp/claude-1000/-home-mike-nexus-code/f49bb728-a69a-48c0-89ef-013caf5b0791/scratchpad
rm -f $S/gw-noverify.log; node $S/fakegw.mjs 19111 noverify $S/gw-noverify.log >/dev/null 2>&1 & GW=$!; sleep 0.7
cd $S/ws && git checkout -q . && git clean -fdq && git worktree prune; for b in $(git branch --list 'nexus/*' | tr -d ' '); do git branch -D $b -q; done; rm -rf .nexus
echo "operator wip" > operator_wip.txt     # root is dirty (untracked)
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t HOME=$S/home LOCAL_LLM_ENDPOINT=http://127.0.0.1:19111/v1 node /home/mike/nexus-code/cli/dist/index.js run -m engineering/b0 -s 6 --worktree --authoritative-verifier "true" -j "make x.txt"
echo EXIT=$?
kill $GW
