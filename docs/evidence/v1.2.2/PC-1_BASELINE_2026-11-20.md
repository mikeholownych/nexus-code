# PC-1 PR CI baseline

Collected: 2026-11-20 11:48 UTC

- Repository baseline: `f6d90a6fbe4a361f6379480f9e19a9f2aff02222` (`origin/main` at collection).
- Source: GitHub Actions workflow `ci.yml`, `pull_request` events.
- Sample: the latest 20 completed, non-cancelled workflow executions returned by `gh run list`; these are execution attempts, not 20 distinct pull requests. Failed attempts are included because they still consume PR feedback time.
- Elapsed time: `updatedAt - createdAt`, so it includes queue time and is an end-to-end workflow measure.
- Results: 17 successes and 3 failures; median **42:19**; range **33:41–47:11**. This is the pre-optimization baseline and does not meet the plan's under-40-minute target.
- Reproduction command: `gh run list --workflow ci.yml --event pull_request --limit 100 --json databaseId,createdAt,updatedAt,status,conclusion,headSha,displayTitle`; filter to `status == completed` and `conclusion != cancelled`, take the first 20 in returned order, and compute `updatedAt - createdAt`.
- Limitations: repeated runs of the same PR/head appear in the sample; queue variation affects wall time; this baseline does not demonstrate the post-optimization 20-run acceptance criterion.

| Run ID | Head SHA | Result | Elapsed | Workflow |
|---:|---|---|---:|---|
| 44715962167 | `88b4d042` | success | 46:16 | ci: remove duplicate assurance work from PR pipeline |
| 44715534431 | `e61a75e5` | failure | 39:28 | ci: remove duplicate assurance work from PR pipeline |
| 44710621826 | `3c1089b1` | failure | 33:41 | ci: remove duplicate assurance work from PR pipeline |
| 44701793074 | `d3430d77` | success | 46:11 | fix(verification): fail closed on resumed typecheck baseline |
| 44689765090 | `0ca9a7e2` | success | 45:24 | docs: reconcile completed v1.2.2 backlog items |
| 44677849035 | `d9e462a2` | success | 42:30 | fix(verification): record bounded shell snapshot uncertainty |
| 44670785395 | `f87ff07f` | success | 46:38 | test(lsp): pin real server workflow toolchains |
| 44663639882 | `7864312d` | failure | 42:08 | fix(verification): record bounded shell snapshot uncertainty |
| 44612975829 | `061dc68c` | success | 47:11 | fix(verification): record bounded shell snapshot uncertainty |
| 44611937888 | `63f4f12c` | success | 42:08 | docs: reconcile completed v1.2.2 backlog items |
| 44611609826 | `ab5a382e` | success | 41:47 | fix(verification): record bounded shell snapshot uncertainty |
| 44608148329 | `421170e5` | success | 45:09 | fix(plugins): isolate observed tool arguments |
| 44607890152 | `fe6fca4e` | success | 34:47 | fix(mcp): avoid retransmitting ambiguous tool calls |
| 44606740931 | `8dee949e` | success | 40:11 | test(lsp): exercise navigation across three-file projects |
| 44606094586 | `99c6049f` | success | 42:01 | test(lsp): exercise navigation across three-file projects |
| 44602636940 | `c7044c49` | success | 45:16 | docs: reconcile completed v1.2.2 backlog items |
| 44601132609 | `35fbea26` | success | 40:25 | docs: reconcile completed v1.2.2 backlog items |
| 44599981531 | `ed6788df` | success | 40:01 | fix(plugins): isolate observed tool arguments |
| 44599201393 | `1a9f6424` | success | 45:02 | fix(security): require workspace trust to weaken verification policy |
| 44597113149 | `75212934` | success | 43:55 | fix(plugins): isolate observed tool arguments |
