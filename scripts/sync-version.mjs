// The root package.json version is the single source of truth (REQ-REL-103). This writes it into cli/package.json,
// cli/package-lock.json, core/Cargo.toml and core/Cargo.lock; `--check` only reports drift and exits 1 when any file
// disagrees (run in CI and the release workflow). `--tag vX.Y.Z` additionally requires the tag to match.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`package.json version '${version}' is not SemVer`);

const drift = [];
const update = (rel, transform) => {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after === before) return;
  drift.push(rel);
  if (!check) fs.writeFileSync(file, after);
};

const jsonVersion = (text, paths) => {
  const data = JSON.parse(text);
  for (const p of paths) {
    let node = data;
    for (const key of p.slice(0, -1)) node = node?.[key];
    if (node && typeof node === "object" && p[p.length - 1] in node) node[p[p.length - 1]] = version;
  }
  return JSON.stringify(data, null, 2) + "\n";
};

update("cli/package.json", (t) => jsonVersion(t, [["version"]]));
update("cli/package-lock.json", (t) => jsonVersion(t, [["version"], ["packages", "", "version"]]));
update("core/Cargo.toml", (t) => t.replace(/^(\[package\][^[]*?\nversion = )"[^"]*"/s, `$1"${version}"`));
update("core/Cargo.lock", (t) => t.replace(/(\[\[package\]\]\nname = "harness-core"\nversion = )"[^"]*"/, `$1"${version}"`));

if (tag !== undefined && tag !== `v${version}`) {
  console.error(`tag ${tag} does not match package.json version ${version}`);
  process.exit(1);
}
if (drift.length) {
  console.error(`${check ? "version drift" : "updated to " + version}: ${drift.join(", ")}`);
  if (check) process.exit(1);
} else {
  console.log(`all components at ${version}`);
}
