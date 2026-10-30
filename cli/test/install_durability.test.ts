import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A rename persists the directory entry, not file data. Re-running the installer
// repoints a working launcher, so the extracted package must be flushed before it
// replaces anything and the launcher switch must be flushed after it, or a power
// loss can leave a 0-byte bin/nexus (the upgrade path is covered by fsyncTree).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lines = fs.readFileSync(path.join(root, "install.sh"), "utf8").split("\n").map((line) => line.trim());

const indexOf = (statement: string) => {
  const index = lines.indexOf(statement);
  assert.ok(index >= 0, `install.sh contains: ${statement}`);
  return index;
};
const syncBetween = (from: number, to: number) => lines.slice(from + 1, to).includes("sync");

test("installer flushes the extracted package before it replaces the installed version", () => {
  assert.ok(syncBetween(indexOf('tar -xzf "$TMP/$ARCHIVE" -C "$TMP/unpack" || fail "archive extraction failed."'), indexOf('rm -rf "$VERSION_DIR"')));
});

test("installer flushes the package move before and the launcher switch after repointing", () => {
  const move = indexOf('mv "$PACKAGE" "$VERSION_DIR"');
  const switchLauncher = indexOf('mv -f "$NEXT" "$LINK"');
  assert.ok(syncBetween(move, indexOf('ln -s "$VERSION_DIR/bin/nexus" "$NEXT"')));
  assert.ok(syncBetween(switchLauncher, indexOf('"$LINK" --version')));
});
