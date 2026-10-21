# Schema 2 retention companion follow-up

11/11 retention tests and TypeScript checking passed after the 1abe3f3 integration checkpoint. Functional fixtures use standard `/tmp` with isolated HOME/XDG; these timings are not SSD persistence evidence.

Companion-only groups left by an interrupted first publication or cleanup now count toward retention and the size cap. They use the existing age/size policy under the same kernel store guard. A newly published parent cancels the old orphan deletion plan. Planning reads current envelope pin/workspace/identity fields instead of trusting stale session-index metadata. Current and pinned tasks remain protected during test-pollution cleanup too.

Full snapshot validation and independent review remain pending. The earlier integration evidence is historical and is not silently rewritten by this follow-up.
