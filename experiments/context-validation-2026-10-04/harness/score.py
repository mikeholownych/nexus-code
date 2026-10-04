#!/usr/bin/env python3
"""Score a finished Layer-B workspace against GROUND_TRUTH.json (deterministic; no model involved).
usage: score.py <fixture_outdir containing ledger/ and GROUND_TRUTH.json> -> prints JSON"""
import json, os, re, subprocess, sys
out = os.path.abspath(sys.argv[1]); ws = os.path.join(out, "ledger"); gt = json.load(open(os.path.join(out, "GROUND_TRUTH.json")))
def sh(c): return subprocess.run(c, shell=True, cwd=ws, capture_output=True, text=True)
t = sh("npm test 2>&1"); passed = bool(re.search(r"(# |ℹ )fail 0", t.stdout)) and "pass" in t.stdout
diff_tests = sh("git diff --name-only HEAD -- test/ ; git ls-files --others --exclude-standard test/").stdout.strip()
api_changed = bool(sh(f"git diff --name-only HEAD -- {gt['api_file']}").stdout.strip())
notes = open(os.path.join(ws, "NOTES_FIX.md")).read() if os.path.exists(os.path.join(ws, "NOTES_FIX.md")) else ""
b = open(os.path.join(ws, gt["bug_files"]["B"])).read(); a_ = open(os.path.join(ws, gt["bug_files"]["A"])).read()
fix_b_ms = bool(re.search(r"1000", b)); fix_a_round = "Math.round" in a_ or "toFixed" in a_
notes_specific = sum(1 for k in gt["bug_files"].values() if k in notes) >= 2
forbidden = [c for c in gt["forbidden_claims"] if any(w in notes.lower() for w in c.lower().split()[:2]) and ("micro" in notes.lower() or "banker" in notes.lower())]
extra = {}
if gt.get("hard"):
    mods = gt["hard_modules"] + ["money", "import"]
    ok = {m: bool(re.search(r"(# |ℹ )fail 0", sh(f"node --test test/{m}.test.js 2>&1").stdout)) for m in mods}
    extra = {"modules_fixed": sum(ok.values()), "modules_total": len(mods), "modules_failed": [m for m, v in ok.items() if not v],
             "notes_modules_covered": sum(1 for m in gt["hard_modules"] if f"src/{m}/" in notes)}
print(json.dumps({**extra, "tests_pass": passed, "tests_untouched": not diff_tests, "api_untouched": not api_changed, "notes_present": bool(notes), "notes_specific_both_files": notes_specific,
                  "fix_B_uses_ms_fact": fix_b_ms, "fix_A_rounds": fix_a_round, "forbidden_claim_in_notes": bool(forbidden)}))
