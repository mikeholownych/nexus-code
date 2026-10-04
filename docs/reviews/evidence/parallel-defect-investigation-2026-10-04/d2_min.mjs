const n = Number(process.argv[2]); const mode = process.argv[3];   // exit | natural | exit-after-write-callback
const s = "x".repeat(n) + "\n";
if (mode === "natural") { process.stdout.write(s); }
else if (mode === "exit") { console.log(s.trimEnd()); process.exit(3); }
else if (mode === "exit-cb") { process.stdout.write(s, () => process.exit(3)); }
