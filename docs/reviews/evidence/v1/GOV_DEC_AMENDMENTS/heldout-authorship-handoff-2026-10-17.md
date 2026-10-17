# Held-out authorship: coordinated handoff request (T2 and T3)

| | |
|---|---|
| Date | 2026-10-17 |
| Requested by | Governance amendment slice `GOV_DEC_AMENDMENTS` (owner-directed) |
| Applies to | REQ-QUAL-101 (T2 held-out), REQ-QUAL-109 (T3 long tasks); CONCURRENCY §8 |
| Authority | Owner, 2026-10-17: **no independence waiver granted.** |

## 1. Current state

- The `HELDOUT_AUTHORING` claim (`$(git rev-parse --git-common-dir)/nexus-claims/HELDOUT_AUTHORING`) is held by `claude-lead (delegated to an isolated author subagent)` for store `~/nexus-heldout`, recorded as **"batch 1 of 4: 10 T2 tasks"**.
- 28 task directories exist (25 complete), 20 manifested. Authoring is **in progress**.
- Whether the current author session is fully isolated from the implementation (no access to Nexus source, the development set, or tuning history) is **not evidenced**. See `custody-report-2026-10-17.md` §2.4 (C4).

## 2. Request (do not act unilaterally)

Per the owner directive, the held-out authorship is to be **reassigned to a separate author** through a coordinated handoff:

1. **Do not interrupt the running agent and do not remove the `HELDOUT_AUTHORING` claim unilaterally.** The implementing agent (codex) and any in-flight authoring session continue undisturbed.
2. **Request transfer at the next safe boundary** — i.e. when the current authoring session pauses or completes a batch. The transfer is recorded in `nexus-claims.log`; the receiving session takes a fresh `HELDOUT_AUTHORING` claim.
3. The receiving author runs in a **separate session with no inherited implementation-session history** and **no access to existing private task payloads** (the current `~/nexus-heldout/tasks/*/hidden/` bodies, the development set, or tuning history). It is given only the accepted task contract and public interfaces (the `task.json` schema, SPEC-10, the external repositories at pinned commits).
4. A **separate custodian** (not the author) is assigned to validate setup, validators, provenance, hashes and sealing. The read-only verification in `custody-report-2026-10-17.md` is the first such pass.

## 3. Disposition of the existing corpus

- The implementer/current-session-authored tasks are **preserved as development/pilot material. They do not qualify as independent held-out evidence** — for **both T2 and T3**.
- New held-out payloads and private validators are **not disclosed to the implementation/tuning agent**.
- Qualification failures receive an **independent validity assessment** before any code change. Any later disclosure of a payload for debugging must be recorded, and any exposed task **must not be reused as fresh held-out evidence**.

## 4. Coordination record

- Claim-log line appended for the transfer request.
- Custodian: the same independent role that produced `custody-report-2026-10-17.md`, pending the owner naming a distinct human/agent.
- Freeze (REQ-QUAL-101): the sealed manifest is committed to the repository before RC1; afterwards no case swap, threshold change, or payload disclosure.

## 5. Status

Open — awaiting the authoring session's next safe boundary. No claim was broken and no running agent was interrupted as part of this request.
