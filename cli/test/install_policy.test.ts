import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The installer is a shell script, so its guardrails are checked at source level
// here and exercised end-to-end by scripts/installer-smoke.sh. Source checks catch
// a guard being moved after the first mutating command or a trap reset dropping
// the conventional signal exit codes; the smoke script covers the live paths.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const lines = source.split("\n").map((line) => line.trim());

const indexOf = (needle: string) => {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `install.sh contains: ${needle}`);
  return index;
};
const has = (needle: string) => lines.some((line) => line.includes(needle));
const block = (start: string, end: string) => {
  const from = indexOf(start);
  const to = lines.indexOf(end, from + 1);
  assert.ok(to > from, `install.sh block ends with: ${end}`);
  return lines.slice(from, to + 1).join("\n");
};

test("installer refuses sudo from a user's shell unless explicitly opted in", () => {
  const guard = indexOf('[ "$(id -u)" -eq 0 ]');
  assert.ok(guard < indexOf("mktemp -d"), "sudo guard runs before the installer creates any temporary state");
  assert.ok(lines.slice(guard, guard + 8).some((line) => line.includes('[ -n "${SUDO_USER:-}" ]')));
  assert.ok(lines.slice(guard, guard + 8).some((line) => line.includes('"$SUDO_USER" != "root"')));
  assert.ok(lines.slice(guard, guard + 8).some((line) => line.includes('${NEXUS_INSTALL_ALLOW_SUDO:-0}') || line.includes('${NEXUS_INSTALL_ALLOW_SUDO:-}')));
  assert.ok(has("Nexus installs into your home directory"));
});

test("installer uses shell-conventional exit codes for SIGINT and SIGTERM", () => {
  assert.ok(has("exit_on_int() { trap - INT; exit 130; }"));
  assert.ok(has("exit_on_term() { trap - TERM; exit 143; }"));
  assert.ok(lines.filter((line) => line.startsWith("arm_signal_exits")).length >= 5, "signal exits are re-armed after every trap reset");
  assert.ok(!has("trap cleanup EXIT HUP INT TERM"), "cleanup traps no longer overwrite the signal exit traps");
  assert.ok(!has("trap api_cleanup EXIT HUP INT TERM"));
  const reset = indexOf("trap - EXIT HUP INT TERM");
  assert.ok(lines.slice(reset, reset + 2).some((line) => line.includes("arm_signal_exits")));
});

test("installer reads an upgrade journal without modifying it and refuses pending states", () => {
  const guard = block('UPGRADE_JOURNAL="$PREFIX/lib/nexus/.upgrade-journal.json"', "fi");
  assert.ok(guard.includes("fs.lstatSync(file).isFile()"));
  assert.ok(guard.includes("fs.realpathSync(file) !== path.resolve(file)"), "redirected journals fail closed");
  assert.ok(guard.includes('["idle", "complete", "rolled_back"].includes(state)'));
  assert.ok(guard.includes('process.stdout.write('), "only a whitelisted state is echoed to the shell");
  assert.ok(!/writeFile|appendFile|unlink|mkdir|rename/.test(guard), "journal inspection is read-only");
  assert.ok(has("pending upgrade journal"));
  assert.ok(indexOf("UPGRADE_JOURNAL=") < indexOf("mktemp -d"), "journal guard runs before downloads or installs");
});

test("GITHUB_TOKEN is used only for the real GitHub API and is never echoed", () => {
  const api = block('API_BASE=${NEXUS_RELEASES_API:-', "fi");
  assert.ok(api.includes('API_AUTH="Bearer $GITHUB_TOKEN"'));
  assert.ok(api.includes('[ -z "${NEXUS_RELEASES_API:-}" ]'), "a custom release API never receives the caller's token");
  assert.ok(has('-H "Authorization: $API_AUTH"'));
  assert.ok(lines.filter((line) => line.includes("api_get -")).length >= 2, "both release lookups use the authenticated helper");
  assert.ok(!lines.some((line) => /printf|echo/.test(line) && line.includes("$GITHUB_TOKEN")), "token value is never printed");
  assert.ok(has("set GITHUB_TOKEN when using GitHub's API"));
});

test("existing package verification and unmanaged-path refusals remain in place", () => {
  assert.ok(has('sha256sum --check --status expected.sha256'));
  assert.ok(has('"$TRUSTED_GH" attestation verify "$TMP/$ARCHIVE"'));
  assert.ok(has('(cd "$VERSION_DIR" && sha256sum --check --status MANIFEST.sha256'));
  assert.ok(has("points outside the Nexus installation"));
  assert.ok(has("exists and is not a symlink"));
});
