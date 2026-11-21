"""Generates the CX-4 (tool-output masking) measurement tasks under eval/tasks/cx4-*. Deterministic (fixed seed).

Run from eval/tasks:  python3 ../gen_cx4_tasks.py
Each task has large tool outputs, which is where masking could help (smaller context) or hurt (the model needed the old
output later). The hidden checks are behavioural; nothing depends on masking being on or off.
"""
import json
import os
import random

random.seed(7)


def w(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(content)


PKG = '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node run-tests.js" }\n}\n'


def task(t, steps, minutes, desc, obj):
    w(f"{t}/task.json", json.dumps({
        "id": t, "tier": "T2", "fixture": "repo", "steps": steps, "minutes": minutes, "description": desc, "objective": obj,
        "hidden": {"dir": "hidden", "command": "node hidden/check.js"}, "regression": {"command": "npm test --silent"},
    }, indent=2) + "\n")


# ---- cx4-verbose-fix: a test runner that prints about a thousand lines per run, failures last
t = "cx4-verbose-fix"
w(f"{t}/repo/package.json", PKG)
w(f"{t}/repo/src/calc.js", '''"use strict";
// Small money helpers. Amounts are integer cents.
function addCents(a, b) { return a + b; }
function percentOf(cents, pct) { return Math.floor(cents * pct / 100); }          // rounds down
function splitEvenly(cents, parts) {
  const base = Math.floor(cents / parts);
  return Array.from({ length: parts }, () => base);                                   // drops the remainder
}
function clampPositive(cents) { return cents < 0 ? 0 : cents; }
function formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; }
module.exports = { addCents, percentOf, splitEvenly, clampPositive, formatCents };
''')
cases = []
for i in range(1, 401):
    a, b = random.randint(1, 9000), random.randint(1, 9000)
    cases.append(["add", i, a, b, a + b])
for i in range(401, 801):
    c = random.randint(100, 100000)
    p = random.choice([5, 7, 10, 12, 15, 18, 25, 33])
    cases.append(["pct", i, c, p, int(c * p / 100 + 0.5)])  # half rounds up
for i in range(801, 1001):
    c = random.randint(10, 100000)
    n = random.choice([2, 3, 4, 5, 7])
    cases.append(["split", i, c, n, c])  # parts must sum to c
w(f"{t}/repo/test/cases.json", json.dumps(cases))
w(f"{t}/repo/run-tests.js", '''"use strict";
// Prints one line per case (about a thousand lines) and the failures last, like a verbose CI reporter.
const { addCents, percentOf, splitEvenly } = require("./src/calc");
const cases = require("./test/cases.json");
let failed = 0;
const failures = [];
for (const [kind, id, x, y, want] of cases) {
  let ok = false, got;
  if (kind === "add") { got = addCents(x, y); ok = got === want; }
  else if (kind === "pct") { got = percentOf(x, y); ok = got === want; }
  else { got = splitEvenly(x, y); ok = got.length === y && got.reduce((s, n) => s + n, 0) === want && Math.max(...got) - Math.min(...got) <= 1; }
  console.log(`${ok ? "PASS" : "FAIL"} #${id} ${kind}(${x}, ${y})${ok ? "" : ` -> ${JSON.stringify(got)}`}`);
  if (!ok) { failed++; failures.push(`#${id} ${kind}(${x}, ${y}) expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
}
console.log(`\\n${cases.length - failed} passed, ${failed} failed`);
if (failed) { console.log("FAILURES (first 12):\\n" + failures.slice(0, 12).join("\\n")); process.exit(1); }
''')
w(f"{t}/hidden/check.js", '''"use strict";
const { percentOf, splitEvenly, addCents } = require("../src/calc.js");
const f = [];
const eq = (g, w, l) => { if (JSON.stringify(g) !== JSON.stringify(w)) f.push(`${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`); };
eq(addCents(2, 3), 5, "add");
eq(percentOf(1050, 10), 105, "pct exact"); eq(percentOf(15, 50), 8, "pct half rounds up"); eq(percentOf(1, 50), 1, "pct 0.5 rounds up"); eq(percentOf(999, 33), 330, "pct 329.67");
const s = splitEvenly(100, 3); eq(s.reduce((a, b) => a + b, 0), 100, "split sums to total"); eq(s.length, 3, "split parts"); eq(Math.max(...s) - Math.min(...s) <= 1, true, "split even to within a cent");
const s2 = splitEvenly(10, 4); eq(s2.reduce((a, b) => a + b, 0), 10, "split 10/4 sums");
if (f.length) { console.error(f.join("\\n")); process.exit(1); }
console.log("ok");
''')
task(t, 60, 25, "Tool-output masking (CX-4): a test run prints about 1000 lines per run and the failures come last; the model reruns it while fixing.",
     "npm test fails. Fix the bugs in src/calc.js so that all cases pass. Do not change the tests or the runner.")

# ---- cx4-log-triage: the cause is two lines in the middle of a 6000-line log
t = "cx4-log-triage"
w(f"{t}/repo/package.json", '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node check.js" }\n}\n')
w(f"{t}/repo/config.json", '{ "retry_limit": 0, "timeout_ms": 50, "pool_size": 4, "region": "eu-west-1" }\n')
lines = []
for i in range(6000):
    ts = f"2026-11-17T10:{(i // 60) % 60:02d}:{i % 60:02d}Z"
    kind = random.choice(["INFO", "INFO", "INFO", "DEBUG", "DEBUG", "WARN"])
    msg = random.choice([
        "request ok path=/api/v1/items", "cache hit key=items:%d" % random.randint(1, 999), "heartbeat peer=%d" % random.randint(1, 20),
        "gc pause ms=%d" % random.randint(1, 40), "slow query ms=%d" % random.randint(50, 300), "connection reused pool=%d" % random.randint(1, 4),
    ])
    lines.append(f"{ts} {kind} {msg}")
lines[3120] = "2026-11-17T10:52:00Z ERROR upstream call failed: timeout after 50ms (config.timeout_ms=50); the upstream p99 is 900ms, set timeout_ms to at least 1000"
lines[3121] = "2026-11-17T10:52:00Z ERROR no retries configured (config.retry_limit=0); a transient failure is final, set retry_limit to at least 2"
w(f"{t}/repo/logs/server.log", "\n".join(lines) + "\n")
w(f"{t}/repo/check.js", '''"use strict";
const c = require("./config.json");
const problems = [];
if (!(c.timeout_ms >= 1000)) problems.push(`timeout_ms ${c.timeout_ms} is below the upstream p99 (see logs/server.log)`);
if (!(c.retry_limit >= 2)) problems.push(`retry_limit ${c.retry_limit} allows no retry (see logs/server.log)`);
if (problems.length) { console.error(problems.join("\\n")); process.exit(1); }
console.log("config ok");
''')
w(f"{t}/hidden/check.js", '''"use strict";
const fs = require("fs");
const path = require("path");
const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const f = [];
if (!(c.timeout_ms >= 1000)) f.push("timeout_ms too low");
if (!(c.retry_limit >= 2)) f.push("retry_limit too low");
if (c.pool_size !== 4 || c.region !== "eu-west-1") f.push("unrelated settings were changed");
const log = fs.readFileSync(path.join(__dirname, "..", "logs", "server.log"), "utf8").split("\\n").length;
if (log < 6000) f.push("the log was altered");
if (f.length) { console.error(f.join("\\n")); process.exit(1); }
console.log("ok");
''')
task(t, 40, 15, "Tool-output masking (CX-4): the cause sits in two lines of a 6000-line log; reading it is expensive and the evidence must not be lost.",
     "npm test fails: the service config is wrong. The reasons are in logs/server.log (about 6000 lines). Fix config.json so npm test passes, changing only what the log says is wrong. Do not edit the log.")

# ---- cx4-wide-rename: 18 files read; early reads must stay usable later
t = "cx4-wide-rename"
w(f"{t}/repo/package.json", PKG)
mods = []
for i in range(1, 19):
    body = ['"use strict";', 'const { fmt } = require("./util");', f"// module m{i}: formats its own records"]
    for k in range(1, 9):
        body.append(f"function rec{i}_{k}(x) {{ return fmt(`m{i}.{k}:` + x); }}")
    body.append("module.exports = { " + ", ".join(f"rec{i}_{k}" for k in range(1, 9)) + " };")
    for k in range(40):
        body.append(f"// note {i}.{k}: keep this comment, it documents record {i}_{k % 8 + 1}")
    w(f"{t}/repo/src/m{i}.js", "\n".join(body) + "\n")
    mods.append(f"m{i}")
w(f"{t}/repo/src/util.js", '"use strict";\nfunction fmt(s) { return String(s).trim().toUpperCase(); }\nmodule.exports = { fmt };\n')
w(f"{t}/repo/src/index.js", '"use strict";\n' + "\n".join(f'Object.assign(exports, require("./{m}"));' for m in mods) + '\nexports.fmt = require("./util").fmt;\n')
w(f"{t}/repo/run-tests.js", '"use strict";\nconst api = require("./src");\nlet bad = 0;\nfor (let i = 1; i <= 18; i++) for (let k = 1; k <= 8; k++) { const got = api[`rec${i}_${k}`]("x "); const want = `M${i}.${k}:X`; if (got !== want) { bad++; console.log(`FAIL rec${i}_${k}: ${got}`); } }\nconsole.log(bad ? `${bad} failing` : "all records ok");\nprocess.exit(bad ? 1 : 0);\n')
w(f"{t}/hidden/check.js", '''"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "src");
const f = [];
const util = require(path.join(root, "util.js"));
if (typeof util.formatValue !== "function") f.push("util.formatValue is missing");
if (util.fmt !== undefined) f.push("the old name fmt is still exported");
for (const name of fs.readdirSync(root)) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  if (/\\bfmt\\b/.test(text.replace(/\\/\\/ note .*$/gm, ""))) f.push(`${name} still uses fmt`);
  if (/^m\\d+\\.js$/.test(name) && (text.match(/\\/\\/ note /g) || []).length !== 40) f.push(`${name}: comments were removed or changed`);
}
const api = require(path.join(root, "index.js"));
if (api.rec7_3("x ") !== "M7.3:X") f.push("behaviour changed");
if (f.length) { console.error(f.join("\\n")); process.exit(1); }
console.log("ok");
''')
task(t, 80, 30, "Tool-output masking (CX-4): rename a helper used in 18 files; reading them all is expensive and the model must remember what it saw.",
     "Rename the helper `fmt` to `formatValue` everywhere: its definition and export in src/util.js and every use in src/m1.js to src/m18.js and src/index.js. Keep behaviour and every comment unchanged, and keep npm test passing. The old name must not remain.")
