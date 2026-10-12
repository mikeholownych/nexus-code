import { createLedger, queueSteering, renderPinnedLedger, readObjective } from "../src/core/objective.js";
const l = createLedger("Audit the repo:\n1. Review module A\n2. Review module B\n");
queueSteering(l, "s1", "CONSTRAINT-ALPHA: never edit files under vendor/.");
queueSteering(l, "s2", "Context for the next part. " + "Background detail. ".repeat(40) + "CONSTRAINT-OMEGA: do not run the network tests.");
for (let i = 3; i <= 12; i++) queueSteering(l, `s${i}`, `minor note ${i}`);
for (const s of l.steering) s.status = "applied";
const block = renderPinnedLedger(l, false);
console.log(JSON.stringify({
  steeringRecords: l.steering.length,
  alphaInPinnedBlock: block.includes("CONSTRAINT-ALPHA"),
  omegaInPinnedBlock: block.includes("CONSTRAINT-OMEGA"),
  s2Length: l.steering[1].text.length,
  readObjectiveReturnsAlpha: readObjective(l, { offset: 0, length: 20000 }).text.includes("CONSTRAINT-ALPHA"),
}));
