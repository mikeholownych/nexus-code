import * as readline from "node:readline/promises";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const got = [];
try { while (true) { const l = await rl.question(""); got.push(l); await new Promise(r => setTimeout(r, 50)); } } catch {}
console.error("questions answered:", JSON.stringify(got));
