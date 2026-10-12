import { incompleteOutputNotice } from "../src/core/findings.js";
const out = (n: number) => JSON.stringify({ stdout: Array.from({ length: n }, (_, i) => `cli/src/x${i}.ts:1: match`).join("\n") + "\n", stderr: "", exit_code: 0 });
const cases: Array<[string, number]> = [
  ["grep -rn spawn cli/src | head -20", 20],
  ["grep -rn spawn cli/src | head -n 20", 20],
  ["grep -rn -m 3 spawn cli/src", 3],
  ["grep -rln spawn cli/src | sed -n '1,5p'", 5],
  ["grep -rn spawn cli/src | awk 'NR<=5'", 5],
  ["grep -rn spawn cli/src | head -c 300", 3],
  ["cd cli/src && grep -rn spawn . 2>/dev/null | head -5; echo done", 6],
];
for (const [command, n] of cases) console.log(JSON.stringify({ command, flagged: Boolean(incompleteOutputNotice("run_command", { command }, out(n))) }));
