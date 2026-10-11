# Recovered `/doctor` request (verbatim)

Source: `nexus-session-session_20261011_162349_6lvu.json`, message 1 (structured context memory),
note prefixed `Earlier task requests:`. The follow-up request in the same session was `proceed with implementation.`
Historical evidence of scope; the matrix in `NEXUS_MATURITY_FIXES_2026-10-11.md` tracks each item.

---

Design, plan, and implement a shared Nexus troubleshooting system exposed through `/doctor` and `nexus doctor`.

Work in the Nexus repository on this development server. Establish the repository root from the current working directory and read applicable `AGENTS.md` instructions before editing. If you cannot locate the repository, ask for its location.

Discover paths, filenames, architecture, and supported interfaces from the actual checkout. Do not assume filesystem references from another environment.

Use Claude Code and other harnesses as behavioral references, while designing around Nexus’s current architecture.

Inspect:
- CLI entry points and existing health-check or troubleshooting commands.
- Configuration loading, validation, precedence, and authentication.
- Slash-command registration, routing, help, and completion.
- Interactive terminal, REPL, and sidecar interfaces where present.
- Engine discovery, shell execution, sessions, durable task state, MCP, and plugin loading.

Write a concise design and implementation plan grounded in what you find, then implement it. Do not stop after producing the plan or pause for routine approval. Resolve ordinary implementation choices yourself and record material assumptions.

Requirements:

1. Shared diagnostic engine
   - `/doctor` and `nexus doctor` must use the same checks and structured results.
   - `/doctor` diagnoses the active session’s effective configuration.
   - `nexus doctor` works without starting an agent session or requiring a working model connection.
   - Diagnose malformed configuration even when normal startup would fail.
   - Consolidate existing health-check behavior while preserving compatibility.
   - Integrate help and completion across supported interfaces.

2. Useful diagnostics
   Inspect the capabilities actually present in Nexus and cover:
   - Installation version, runtime compatibility, and executable resolution.
   - Configuration validity, precedence, sources, and effective values.
   - Endpoint connectivity, authentication, and configured model availability.
   - Engine readiness and shell availability.
   - Workspace and state-directory access.
   - Session or durable-state integrity where practical.
   - Configured MCP and plugin problems.

   Distinguish missing optional capabilities from failures that prevent normal operation. Separate configuration observations from verified runtime behavior. A successful model-list request must not be reported as proof that inference works.

   Show the likely cause and a concrete next action for each issue. Avoid generic advice when evidence supports a specific diagnosis.

3. Fast, bounded execution
   - Keep default checks fast and minimally invasive.
   - Use explicit timeouts, cancellation, and bounded output.
   - Continue independent checks when one fails.
   - Make skipped, unsupported, and incomplete checks explicit.
   - Offer deeper checks through `--deep` where useful.
   - Clearly identify any inference probe that incurs cost or model work.
   - Do not blindly start arbitrary plugins or MCP processes during default checks.
   - Avoid initializing the full agent merely to diagnose a broken client.

4. Consistent output
   Every finding must include:
   - A stable identifier.
   - Status: `pass`, `warn`, `fail`, or `skip`.
   - A concise explanation.
   - Supporting evidence.
   - A specific next action when needed.
   - Whether a supported automatic repair is available.

   Provide readable terminal and session output, plus `nexus doctor --json` with a versioned schema.

   Define and document exit codes for healthy results, warnings, failures, and diagnostic execution errors. JSON mode must emit machine-readable output without decorative text.

   Redact credentials, authorization headers, URL secrets, and sensitive configuration values from all output formats and exception paths.

5. Controlled repairs
   Support `nexus doctor --fix` and `/doctor --fix` for a small, explicit set of deterministic repairs justified by the implementation.

   Default diagnosis must not alter persistent configuration or user data. Before repair:
   - Show the proposed changes.
   - Require confirmation for mutations.
   - Honor existing read-only and approval policies.
   - For unattended use, require an explicit flag such as `--yes`, limited to supported safe repairs.

   Repairs must be narrowly scoped and idempotent. Preserve backups when modifying existing files, avoid overwriting concurrent changes, and rerun affected checks afterward. Report attempted, successful, failed, and unresolved repairs accurately.

   Do not silently reset configuration, delete sessions or checkpoints, rotate credentials, install dependencies, disable TLS verification, restart external services, or modify production infrastructure. Provide concrete manual steps for actions outside the supported repair scope.

6. Interactive behavior
   - Keep diagnostic output independent of conversation history and model inference.
   - Use existing concurrency and cancellation rules.
   - During active turns, allow safe diagnostics where the architecture supports them.
   - Explain busy-state limitations clearly.
   - Defer repairs that could race with active work.
   - Preserve existing command behavior and session state.

Implementation expectations:
- Follow existing project conventions.
- Keep checks modular and independently testable.
- Reuse actual configuration, engine-discovery, and client-resolution logic so diagnostics reflect what Nexus uses.
- Avoid duplicating configuration rules or inventing a parallel startup system.
- Use deterministic checks rather than asking an LLM to decide whether the client is healthy.
- Keep the first implementation focused on useful, reliable troubleshooting.

Validation:
- Run repository-required builds and tests.
- Add meaningful tests for malformed configuration, unreachable and timed-out endpoints, authentication failure, unavailable models, missing engine or shell, inaccessible state paths, output redaction, JSON schema, and exit codes.
- Test repair confirmation, read-only enforcement, idempotence, backups, and verification after repair.
- Verify both entry points share diagnostic behavior while correctly distinguishing active-session and fresh-CLI configuration.
- Verify doctor still runs when ordinary agent initialization fails.
- Use isolated fixtures and mock endpoints rather than live credentials or production services.
- Verify help, completion, and supported interactive interfaces.

Deliver:
- The implemented commands and shared diagnostic engine.
- A saved design and implementation plan.
- User documentation covering checks, statuses, flags, exit codes, supported repairs, and limitations.
- Examples of default diagnosis, JSON output, deeper checks, and repair workflows.

Finish with a concise report explaining what changed, what was tested, which repairs are supported, and any remaining limitations. Do not claim checks passed unless you ran them.
