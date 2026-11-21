"use strict";
const { percentOf, splitEvenly, addCents } = require("../src/calc.js");
const f = [];
const eq = (g, w, l) => { if (JSON.stringify(g) !== JSON.stringify(w)) f.push(`${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`); };
eq(addCents(2, 3), 5, "add");
eq(percentOf(1050, 10), 105, "pct exact"); eq(percentOf(15, 50), 8, "pct half rounds up"); eq(percentOf(1, 50), 1, "pct 0.5 rounds up"); eq(percentOf(999, 33), 330, "pct 329.67");
const s = splitEvenly(100, 3); eq(s.reduce((a, b) => a + b, 0), 100, "split sums to total"); eq(s.length, 3, "split parts"); eq(Math.max(...s) - Math.min(...s) <= 1, true, "split even to within a cent");
const s2 = splitEvenly(10, 4); eq(s2.reduce((a, b) => a + b, 0), 10, "split 10/4 sums");
if (f.length) { console.error(f.join("\n")); process.exit(1); }
console.log("ok");
