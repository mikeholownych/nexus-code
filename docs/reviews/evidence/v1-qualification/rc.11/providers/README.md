# RC11 installed-artifact provider verification

## Candidate identity

- Release: `v1.0.0-rc.11`
- Source commit: `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`
- Published Linux x86-64 archive SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`
- Installed binary: `/home/mike/.local/nexus-rc11-qualification/bin/nexus`
- Installed version output: `1.0.0-rc.11 (8d4e5319f1a3)`
- Environment: Ubuntu 26.04.1 LTS, x86_64, Node v22.22.1, `ubuntu-desktop` (`10.0.8.3`)
- Install method: official release installer into an isolated prefix; SHA-256 and GitHub build provenance checks passed. The installed provenance, compatibility metadata and package manifest are preserved under `install/`.

## Execution boundaries

Each verification ran from a new empty `/tmp/nexus-rc11-e5-*` workspace through the installed RC11 binary. The provider credentials remained in the operator's existing credential store and were consumed by Nexus; no credential value was read, copied or archived. `providers verify` sends only its built-in connectivity/tool-call prompts and no workspace content. The raw verification JSON, stderr and receipt records are retained for every attempt.

## Results

| Provider | Model | Result | Evidence |
|---|---|---|---|
| ChatGPT sign-in | `gpt-6-luna` | **PASS** — streamed completion, tool call and tool-result round trip passed; 3 receipts | `chatgpt/` |
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | **VERIFY PASS on attempt 3** — streamed completion, tool call and tool-result round trip passed; 3 receipts. Provider reported $0.00. | `openrouter-attempt-3/` |

After attempt 3 passed, one authorized synthetic live task ran in a fresh temporary workspace containing only `math.js` and its two-case Node test. The first task run made the intended one-line fix, but its completion was not established: the operator-configured verifier binding treated the imported source as verifier support because the fixture had no package manifest or declared deliverable. The test command passed in-run and independently after the task. A fresh repeat declared `math.js` with `--deliverable-file`; Nexus then completed `VERIFIED`, and an independent post-run invocation passed 2/2 tests. Both runs and the first run's refusal remain recorded. The original `TEMPORARILY_UNAVAILABLE` outcomes from attempts 1 and 2 are preserved as historical failures; attempt 3 does not erase them.

This packet covers installed-RC provider verification and one bounded synthetic task. It does not establish standalone, held-out, T3/T4, or overall RC acceptance.
