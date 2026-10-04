# Disposition after context validation (2026-10-04)

Evidence: `experiments/context-validation-2026-10-04/RESULTS.md` (commit 9b6efe9). Scope of validity: current Nexus + aihost gateway (llama.cpp prefix cache),
one recorded trace, one synthetic fixture family, Layer B n=4/cell, length study on `engineering/b0` only. Revisit if the runtime, cache, model or workload changes.

| Item | Disposition |
|---|---|
| Turn-specific context planner | REJECTED for the current architecture / evidence envelope (not disproven) |
| Per-turn history rebuild / eviction as default | REJECTED (prefill x1.2-12, wall x1.1-9.5 on replay) |
| Prefix stability | Material inference-cost property; treat as a design constraint |
| Context-length degradation <=49k | Not demonstrated (b0, 30 trials/size, 0.93-1.00, no trend); not a general claim |
| Plain 65k context | Preferred default for the tested controlled task (4/4, 11.8 requests, 351 s) |
| 32k reduction policy | Functionally effective, expensive fallback (4/4, 50 requests, 960 s) |
| Bounded ingestion + raw kept by reference | Retain as candidate |
| Exact-duplicate back-references | Retain as candidate |
| Pinned objective | Retain |
| Evidence-based stagnation detection | Retain as candidate |
| Eviction | Conditional capacity control (epoch-based), not routine optimisation |

Separate defects (not context architecture): `run -j` stdout truncated ~64 KB when piped; `ContextBudgetError` makes a 32k limit unusable for plain Nexus;
multi-line paste loss; 35 s verifier RPC timeout.

No implementation of the retained mechanisms is authorised or started; Phase 3 is undisturbed. Follow-up, after Phase 3: keep the conversational prefix stable,
cap pathological single observations, store full evidence outside the packet, and manipulate history destructively only when the window requires it.
