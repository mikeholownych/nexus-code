// Keep the oracle source available for its first Node module load, while hiding it from task code on disk.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const saved = new Map();
try {
  const files = JSON.parse(process.env.NEXUS_HIDDEN_FILES || "[]");
  for (const file of files) {
    const absolute = path.resolve(file);
    const contents = fs.readFileSync(absolute);
    saved.set(absolute, contents);
    fs.writeFileSync(absolute, "");
  }
} catch (error) {
  throw new Error(`could not hide oracle files: ${error.message}`);
} finally {
  delete process.env.NEXUS_HIDDEN_FILES;
  delete process.env.NODE_OPTIONS;
}

for (const extension of [".js", ".cjs"]) {
  const load = Module._extensions[extension];
  if (!load) continue;
  Module._extensions[extension] = function loadOracleOrModule(module, filename) {
    const absolute = path.resolve(filename);
    if (!saved.has(absolute)) return load(module, filename);
    const source = saved.get(absolute);
    saved.delete(absolute);
    module._compile(source.toString("utf8"), filename);
  };
}
