# Bounded JSON metadata retention correction

Base: 7969dc05188fece02f60993f015e7ed62cb45546. Source hashes identify the working patch validated here.

Three negative controls fail on unchanged base source: a large legacy record with an escaped pinned key loses protection; an escaped session alias loses current-session protection; replacement after the planning stat causes an unbounded 2,097,212-byte whole-file read. The fixtures are synthetic and never access operator state.

The small-file fast path now opens a nonblocking no-follow regular-file descriptor, inspects that opened file and reads at most 64KiB+1 positionally. Larger or grown files use the same descriptor's bounded streaming path from offset zero. No stale path stat can authorize an unbounded read. The scanner preserves raw UTF8 bytes and JSON escapes until a bounded selected metadata token closes, then uses JSON.parse for decoding. Unselected strings are skipped. Selected key/value buffers have fixed bounds; oversized selected values are retained conservatively rather than used to authorize pruning. Pin scalars retain the ordinary JSON/Boolean semantics used by the small-file path.

Four new tests cover escaped pin keys, Unicode/escaped workspace values, current-session aliases, JSON pin-value semantics and the deterministic stat/replacement race. Pin/current cases exercise actual GC with an expired age and size pressure and require preservation.

Validation: retention.test.ts plus retention_state_v2.test.ts:20/20 passed, no failures/skips. tsc --noEmit:exit0. Negative controls:3 expected failures,8 filtered tests, not acceptance passes. HOME/XDG/TMPDIR were isolated under /var/tmp with the local SUITE claim.

This is a source correction. Upgrade restore interruption remains a separate open blocker; final current-base review and exact-head CI are still required. No installed-RC, human, product or release acceptance is claimed.
