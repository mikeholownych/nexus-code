#!/usr/bin/env python3
"""Generate the Layer-B engineering fixture ("ledger") deterministically from a seed.

The fixture is a small dependency-free Node project with
  - OBJECTIVE.md        : the objective + 3 constraints (delivered via file/argv, never a pasted REPL prompt)
  - docs/OPS_NOTES.md   : a short early-orientation fact that becomes decisive much later (delayed relevance)
  - bug A (visible)     : money rounding, found from a failing test message
  - bug B (delayed)     : legacy importer timestamps are epoch MILLISECONDS; the failing test message carries no hint,
                          the fix needs the fact in docs/OPS_NOTES.md (planted among distractors)
  - distractors         : large CHANGELOG, noisy fixture JSON, near-miss notes with *different scopes* (stale/lookalike facts)
  - verifier            : `node --test` (must finish well under the 35 s RPC timeout; checked by preflight.py)
Ground truth for scoring is in GROUND_TRUTH.json (kept OUTSIDE the workspace the model sees).

usage: make_fixture.py <outdir> [--seed N]
"""
import json, os, random, sys, textwrap

def w(root, rel, text):
    p = os.path.join(root, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text)

FACTS_HARD = [
    # (module, fact line for OPS_NOTES, lookalike for PARTNER notes or None, buggy src, fixed-behaviour test)
    ("cutoff", "Settlement cut-off is 17:00 UTC and is INCLUSIVE (a transaction at exactly 17:00 settles the same day).", "Partner v2 cut-off is 16:00 UTC and exclusive; not applicable here.",
     "export function settlesSameDay(h, m) { return h < 17 || (h === 17 && m < 0); }", "assert.equal(settlesSameDay(17, 0), true); assert.equal(settlesSameDay(17, 1), false);"),
    ("ids", "Account ids are zero-padded to 8 digits.", "Partner v2 ids are 12 digits; not applicable.",
     "export function padId(n) { return String(n).padStart(6, '0'); }", "assert.equal(padId(42), '00000042');"),
    ("currency", "The default currency for unlabelled amounts is CAD.", "Partner v2 defaults to USD; not applicable.",
     "export function label(amount, cur) { return `${cur || 'USD'} ${amount.toFixed(2)}`; }", "assert.equal(label(12.5), 'CAD 12.50'); assert.equal(label(3, 'EUR'), 'EUR 3.00');"),
    ("fees", "Fee rates are stored as fractions: 1.5% is 0.015.", None,
     "const RATES = { eu: 0.02, na: 0.01, apac: 1.5 };\nexport function fee(region, cents) { return Math.round(cents * RATES[region]); }", "assert.equal(fee('apac', 10000), 150); assert.equal(fee('eu', 10000), 200);"),
    ("bizdays", "Business days exclude Saturday AND Sunday.", None,
     "export function isBusinessDay(d) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w !== 0; }", "assert.equal(isBusinessDay('2026-10-03'), false); assert.equal(isBusinessDay('2026-10-04'), false); assert.equal(isBusinessDay('2026-10-05'), true);"),
    ("idem", "Idempotency keys are case-SENSITIVE.", "Partner v2 keys are case-insensitive; not applicable.",
     "const seen = new Set();\nexport function firstTime(key) { const k = key.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }", "assert.equal(firstTime('AbC'), true); assert.equal(firstTime('abc'), true);"),
]

def hard_mode(ws, r, names):
    notes = open(os.path.join(ws, "docs/OPS_NOTES.md")).read()
    partner = open(os.path.join(ws, "docs/PARTNER_FEED_NOTES.md")).read()
    for mod, fact, look, buggy, test in FACTS_HARD:
        notes += f"- {fact}\n"
        if look: partner += f"- {look}\n"
        filler = "\n".join(f"// helper {i}: {' '.join(r.choice(['normalise','region','window','audit','limit','cache','report']) for _ in range(8))}\nexport function {mod}_h{i}(x) {{ return (x * {r.randint(2, 9)} + {r.randint(1, 99)}) % {r.randint(100, 999)}; }}" for i in range(70))
        w(ws, f"src/{mod}/core.js", "// " + mod + " module\n" + buggy + "\n\n" + filler + "\n")
        w(ws, f"test/{mod}.test.js", f"import test from 'node:test'; import assert from 'node:assert/strict';\nimport * as m from '../src/{mod}/core.js';\nconst {{ {', '.join(x for x in ('settlesSameDay','padId','label','fee','isBusinessDay','firstTime') if x in buggy)} }} = m;\ntest('{mod}', () => {{ {test} }});\n")
    w(ws, "docs/OPS_NOTES.md", notes); w(ws, "docs/PARTNER_FEED_NOTES.md", partner)
    idx = open(os.path.join(ws, "src/index.js")).read()
    for mod, *_ in FACTS_HARD:
        fn = {"cutoff": "settlesSameDay", "ids": "padId", "currency": "label", "fees": "fee", "bizdays": "isBusinessDay", "idem": "firstTime"}[mod]
        idx += f"export {{ {fn} }} from \"./{mod}/core.js\";\n"
    w(ws, "src/index.js", idx)
    w(ws, "test/filler.test.js", "import test from 'node:test';\n" + "\n".join(f"test('filler {i}', () => {{}});" for i in range(120)) + "\n")
    w(ws, "OBJECTIVE.md", textwrap.dedent("""\
        # Objective
        `npm test` currently fails in several places. Find ALL root causes in `src/` and fix them so that `npm test` passes.
        Project conventions are documented under `docs/` (the ops notes are authoritative for this repository).

        ## Constraints
        1. Do NOT modify anything under `test/`.
        2. Do NOT change existing exports in `src/index.js` (adding none is fine).
        3. Before finishing, create `NOTES_FIX.md` listing each root cause with the file path of the fix and why that fix is correct.

        ## Done means
        `npm test` passes, constraints 1-3 hold, and NOTES_FIX.md lists every root cause specifically.
        """))

def main():
    out = sys.argv[1]; seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 1
    r = random.Random(seed); ws = os.path.join(out, "ledger"); gt = {}
    os.makedirs(ws, exist_ok=True)
    w(ws, "package.json", json.dumps({"name": "ledger", "version": "1.0.0", "type": "module", "scripts": {"test": "node --test"}}, indent=2) + "\n")

    # --- core modules
    w(ws, "src/money.js", textwrap.dedent("""\
        // Money helpers. Amounts are integer cents.
        export function toCents(amount) {
          return Math.floor(amount * 100);          // BUG A: floors instead of rounding (19.99 -> 1998)
        }
        export function fromCents(cents) { return cents / 100; }
        export function sumCents(list) { return list.reduce((a, b) => a + b, 0); }
        """))
    w(ws, "src/time.js", textwrap.dedent("""\
        // Settlement window helpers. All internal timestamps are epoch SECONDS.
        export function withinWindow(ts, startSec, endSec) { return ts >= startSec && ts < endSec; }
        export function toDate(tsSeconds) { return new Date(tsSeconds * 1000); }
        """))
    w(ws, "src/import/legacy.js", textwrap.dedent("""\
        import { withinWindow } from "../time.js";
        // Imports rows from the legacy exporter.
        export function importLegacy(rows, startSec, endSec) {
          return rows.filter((row) => withinWindow(row.ts, startSec, endSec));   // BUG B: row.ts is MILLISECONDS here
        }
        """))
    w(ws, "src/reports/totals.js", textwrap.dedent("""\
        import { toCents, sumCents } from "../money.js";
        export function totalCents(amounts) { return sumCents(amounts.map(toCents)); }
        """))
    w(ws, "src/index.js", textwrap.dedent("""\
        // PUBLIC API: do not change these signatures.
        export { toCents, fromCents, sumCents } from "./money.js";
        export { withinWindow, toDate } from "./time.js";
        export { importLegacy } from "./import/legacy.js";
        export { totalCents } from "./reports/totals.js";
        """))

    # --- filler modules (plausible, irrelevant, individually small)
    names = [f"acct{i:02d}" for i in range(24)]
    for n in names:
        w(ws, f"src/accounts/{n}.js", f"export function describe_{n}() {{ return {{ id: '{n}', limit: {r.randint(100, 9999)}, region: '{r.choice(['eu','na','apac'])}' }}; }}\n")
    w(ws, "src/accounts/index.js", "".join(f"export * from './{n}.js';\n" for n in names))

    # --- tests (the verifier)
    w(ws, "test/money.test.js", textwrap.dedent("""\
        import test from "node:test"; import assert from "node:assert/strict";
        import { toCents, totalCents } from "../src/index.js";
        test("toCents rounds to nearest cent", () => assert.equal(toCents(19.99), 1999));
        test("totals", () => assert.equal(totalCents([19.99, 0.01]), 2000));
        """))
    base_s = 1700000000
    rows = [{"id": i, "ts": (base_s + i * 60) * 1000, "amt": i} for i in range(10)]
    w(ws, "test/import.test.js", textwrap.dedent(f"""\
        import test from "node:test"; import assert from "node:assert/strict";
        import {{ importLegacy }} from "../src/index.js";
        const rows = {json.dumps(rows)};
        test("legacy import keeps rows inside the settlement window", () => {{
          const got = importLegacy(rows, {base_s + 120}, {base_s + 420});
          assert.equal(got.length, 5);
        }});
        """))
    w(ws, "test/accounts.test.js", textwrap.dedent("""\
        import test from "node:test"; import assert from "node:assert/strict";
        import * as a from "../src/accounts/index.js";
        test("accounts describe", () => assert.equal(Object.keys(a).length, 24));
        """))

    # --- docs: the decisive early fact + lookalikes with different scopes + big distractors
    w(ws, "docs/OPS_NOTES.md", textwrap.dedent("""\
        # Ops notes (read before touching importers)
        - Settlement timestamps inside ledger are epoch SECONDS.
        - The legacy exporter (src/import/legacy.js input) emits epoch MILLISECONDS in `ts`; importers must divide by 1000 before comparing with internal windows.
        - The *new* partner feed (not in this repo) emits ISO-8601 strings; ignore for legacy work.
        """))
    w(ws, "docs/PARTNER_FEED_NOTES.md", textwrap.dedent("""\
        # Partner feed (v2) — different system
        - Partner v2 timestamps are epoch MICROSECONDS. Do not apply this to the legacy exporter.
        - Rounding for partner v2 amounts is banker's rounding; the internal ledger rounds half up.
        """))
    lines = []
    for i in range(1800):
        lines.append(f"## v{1 + i // 40}.{i % 40}\n- {r.choice(['fix','chore','feat','docs'])}: {' '.join(r.choice(['account','settlement','window','export','import','rounding','region','limit','cache','report','audit']) for _ in range(r.randint(6, 14)))}\n")
    w(ws, "docs/CHANGELOG.md", "# Changelog\n\n" + "\n".join(lines))
    w(ws, "docs/ARCHITECTURE.md", "# Architecture\n\n" + "\n".join(f"Module {n}: provides account descriptor {n}; see src/accounts/{n}.js. " + " ".join(r.choice(['stable','cached','read-only','region-scoped']) for _ in range(30)) for n in names))
    w(ws, "TODO.md", "# TODO (aspirational, unrelated to the objective)\n" + "\n".join(f"- [ ] {r.choice(['Migrate','Refactor','Document','Benchmark'])} {r.choice(names)} {r.choice(['cache','limits','region logic'])}" for _ in range(60)) + "\n")
    w(ws, "fixtures/noise_transactions.json", json.dumps([{"id": i, "acct": r.choice(names), "amt": round(r.random() * 1000, 2), "memo": "x" * r.randint(20, 120)} for i in range(1500)]))

    w(ws, "OBJECTIVE.md", textwrap.dedent("""\
        # Objective
        `npm test` currently fails. Find the root cause(s) in `src/` and fix them so that `npm test` passes.

        ## Constraints
        1. Do NOT modify anything under `test/`.
        2. Do NOT change the public API in `src/index.js` (names or signatures).
        3. Before finishing, create `NOTES_FIX.md` listing each root cause with the file path of the fix and why that fix is correct.

        ## Done means
        `npm test` passes, constraints 1-3 hold, and the root causes in NOTES_FIX.md are specific.
        """))


    if "--hard" in sys.argv:
        hard_mode(ws, r, names)
        gt_hard = True

    # --- ground truth (outside workspace)
    gt = {"seed": seed, "required_facts": [
              {"id": "legacy_ms", "source": "docs/OPS_NOTES.md", "fact": "legacy exporter ts is milliseconds; divide by 1000", "needed_at": "fix src/import/legacy.js"},
              {"id": "round_half_up", "source": "test/money.test.js", "fact": "toCents must round, not floor"}],
          "forbidden_claims": ["partner v2 microseconds applies to legacy importer", "banker's rounding applies to internal ledger"],
          "protected_paths": ["test/"], "api_file": "src/index.js", "verifier": "npm test",
          "bug_files": {"A": "src/money.js", "B": "src/import/legacy.js"}, "hard": "--hard" in sys.argv, "hard_modules": [m for m, *_ in FACTS_HARD]}
    json.dump(gt, open(os.path.join(out, "GROUND_TRUTH.json"), "w"), indent=2)
    print("fixture at", ws)

if __name__ == "__main__": main()
