// One node:test run over the given files (one file at a time) with a per-file watchdog. Started by run_tests.mjs in its
// own process group; reports to the parent on fd 3 as JSON lines: {"timeout":file,"tail":[...]} when the file under test
// exceeds NEXUS_TEST_FILE_TIMEOUT_SECS (the parent then kills the group and restarts with the remaining files), and
// {"done":true,"tests":n,"fail":n} when the run ends. Output keeps the spec reporter format, with colour on a TTY.
import fs from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const files = process.argv.slice(2);
const cwd = process.cwd();
const timeoutMs = (Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) > 0 ? Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) : 300) * 1000;
const report = (message) => fs.writeSync(3, `${JSON.stringify(message)}\n`);

const stream = run({ files, concurrency: 1, isolation: "process", execArgv: ["--import", "tsx"] });
let timer;
let tail = [];
const lastLines = (text) => { tail = [...tail, ...String(text).split("\n").filter(Boolean)].slice(-20); };
const watch = (file) => {
  clearTimeout(timer);
  tail = [];
  timer = setTimeout(() => report({ timeout: file, tail }), timeoutMs);
};
stream.on("test:dequeue", (e) => {
  if (e.nesting === 0 && e.file && path.resolve(cwd, e.name) === e.file) watch(e.file);
});
stream.on("test:stdout", (e) => lastLines(e.message));
stream.on("test:stderr", (e) => lastLines(e.message));
stream.on("test:pass", (e) => lastLines(`ok ${e.name}`));
stream.on("test:fail", (e) => lastLines(`not ok ${e.name}`));
let counts = { tests: 0, failed: 0 };
stream.on("test:summary", (e) => { if (!e.file) counts = e.counts; });
const output = stream.compose(new spec());
output.pipe(process.stdout, { end: false });
output.on("end", () => {
  clearTimeout(timer);
  report({ done: true, tests: counts.tests, fail: counts.failed });
  process.stdout.write("", () => process.exit(counts.failed ? 1 : 0));
});
