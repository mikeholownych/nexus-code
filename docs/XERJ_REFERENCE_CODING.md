# Reference coding with XERJ

The detail behind the "Reference coding" rule in `AGENTS.md`: how to reach the local XERJ node, what to query, and what to leave alone.

- Before non-trivial code with a peer-project analogue (feature, protocol, parser, worktree or provider handling, tool, test harness), query the local XERJ node and record what you took, borrowed or rejected in the PR's "Reference coding" section. Exempt: trivial edits, doc-only changes, fixes fully specified by a failing test.
- XERJ is an owner-host tool, not a project dependency (`docs/v1.1.0/DECISIONS.md` §1). Where it is unavailable (contributor machine, CI), write "XERJ unavailable: <reason>" in that section and use `git grep` plus the peer's public source.
- The node is the user service `xerj` on `http://localhost:9200`; confirm with `systemctl --user is-active xerj` and use that node. Stop a hub with `xerj hub stop`.
- Corpora: `xerj corpus list`. Retrieval is lexical (BM25), so query with identifiers and words from the code: `xerj code <corpus> "<words>" -k 4 --full 600`, `xerj search --prefix <index-prefix> "<words>" -k 4`, `xerj def --prefix <prefix> "<symbol>"`. The first query can take over a minute; set a timeout.
- `nexus-cli`, `nexus-core`, `nexus-test`, `nexus-docs` index `origin/main` only (hourly), so open PRs are absent: use `git grep` on your branch.
- Reference code is read-only inspiration. Follow each result's licence tag; copy verbatim only permissively licensed code, with a citation. Keep XERJ and reference corpora away from held-out evaluation tasks (`docs/v1.0.0/CONCURRENCY.md`). Keep document text local (`rerank` sends it to a third party). Leave indices you did not create alone.
- After real use: `xerj feedback --dry-run`, then `xerj feedback --submit --agent "<model>" --used-for "<task>" --verdict "<what worked and what did not>"`, with secrets and private data left out.
