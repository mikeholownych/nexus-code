"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "src");
const f = [];
const util = require(path.join(root, "util.js"));
if (typeof util.formatValue !== "function") f.push("util.formatValue is missing");
if (util.fmt !== undefined) f.push("the old name fmt is still exported");
for (const name of fs.readdirSync(root)) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  if (/\bfmt\b/.test(text.replace(/\/\/ note .*$/gm, ""))) f.push(`${name} still uses fmt`);
  if (/^m\d+\.js$/.test(name) && (text.match(/\/\/ note /g) || []).length !== 40) f.push(`${name}: comments were removed or changed`);
}
const api = require(path.join(root, "index.js"));
if (api.rec7_3("x ") !== "M7.3:X") f.push("behaviour changed");
if (f.length) { console.error(f.join("\n")); process.exit(1); }
console.log("ok");
