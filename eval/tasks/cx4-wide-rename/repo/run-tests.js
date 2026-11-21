"use strict";
const api = require("./src");
let bad = 0;
for (let i = 1; i <= 18; i++) for (let k = 1; k <= 8; k++) { const got = api[`rec${i}_${k}`]("x "); const want = `M${i}.${k}:X`; if (got !== want) { bad++; console.log(`FAIL rec${i}_${k}: ${got}`); } }
console.log(bad ? `${bad} failing` : "all records ok");
process.exit(bad ? 1 : 0);
