// Transparent sidecar shim for `nexus-tui --live --sidecar <this file>`: runs the real sidecar named by
// NEXUS_RECORD_SIDECAR and appends every raw stdin chunk to NEXUS_RECORD_COMMANDS and every raw stdout chunk to
// NEXUS_RECORD_EVENTS. It never parses, filters or rewrites bytes. Appends are synchronous so both logs are
// complete when the process exits.
import { spawn } from "node:child_process";
import fs from "node:fs";

const commandsLog = process.env.NEXUS_RECORD_COMMANDS;
const eventsLog = process.env.NEXUS_RECORD_EVENTS;

const child = spawn(process.execPath, [process.env.NEXUS_RECORD_SIDECAR, ...process.argv.slice(2)], {
  stdio: ["pipe", "pipe", "inherit"],
});

process.stdin.on("data", (chunk) => {
  fs.appendFileSync(commandsLog, chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {});
process.stdout.on("error", () => {});

child.stdout.on("data", (chunk) => {
  fs.appendFileSync(eventsLog, chunk);
  process.stdout.write(chunk);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("close", (code) => {
  process.exit(code ?? 1);
});
