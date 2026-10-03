from dogfood import *
open(f"{S}/dogfood-transcript.txt", "w").close()
p = spawn(); p.expect(PRM, timeout=30)
tasks = [
 "Add a function `product(xs)` to src/math.js (empty array returns 1) and tests. Run the tests.",
 "Add `variance(xs)` (population variance) using mean, with tests. Run the tests.",
 "Add `stddev(xs)` using variance, with tests. Run the tests.",
 "Add `percentile(xs, p)` with linear interpolation, with tests. Run the tests.",
 "Refactor src/math.js so every function validates that its input is an array of finite numbers via one shared helper; keep all tests passing.",
 "Summarize in 3 bullets what src/math.js exports and any edge cases that remain untested.",
]
for i,t in enumerate(tasks,1):
    turn(p, t, timeout=400, label=f"L{i}")
    p.sendline("/tokens"); p.expect(PRM, timeout=20)
    o=clean(p.before); m=re.search(r"([\d,]+)\s*/\s*([\d,]+)", o); c=re.search(r"Cumulative[^\n]*", o)
    print("    ", (m.group(0) if m else "?"), "|", c.group(0).strip()[:110] if c else "")
print(sh("git status --short; npm test 2>&1 | grep -E '^# (pass|fail)'"))
p.sendline("/exit"); p.close()
