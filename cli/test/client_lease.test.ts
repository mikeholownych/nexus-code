import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireClientLease, releaseClientLease } from "../src/core/client_lease.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = fs.mkdtempSync(path.join("/var/tmp", "nexus-client-admission-"));

function home(name: string): string {
  const result = path.join(testRoot, name);
  fs.mkdirSync(result, { recursive: true, mode: 0o700 });
  return result;
}

function probe(targetHome: string, maxActiveClients: number): ReturnType<typeof spawnSync> {
  const source = `
    import { acquireClientLease } from "./src/core/client_lease.ts";
    try {
      acquireClientLease(process.env.HOME, { maxActiveClients: ${maxActiveClients} });
      console.log("admitted");
    } catch (error) {
      console.log(error?.name ?? "unknown-error");
      if (error?.name !== "ClientActiveLimitError" && error?.name !== "ResourceAdmissionConflictError") process.exitCode = 2;
    }
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: cliRoot,
    env: { ...process.env, HOME: targetHome, XDG_CONFIG_HOME: path.join(targetHome, ".config") },
    encoding: "utf8",
    timeout: 15_000,
  });
}

after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

describe("cross-process client admission", { skip: process.platform !== "linux" || typeof process.getuid !== "function" }, () => {
  it("denies another same-home client at the configured limit and reopens admission on release", () => {
    const targetHome = home("same-home");
    const lease = acquireClientLease(targetHome, { maxActiveClients: 1 });
    try {
      const denied = probe(targetHome, 1);
      assert.equal(denied.status, 0, denied.stderr);
      assert.equal(denied.stdout.trim(), "ClientActiveLimitError");
    } finally {
      releaseClientLease(lease);
    }

    const admitted = probe(targetHome, 1);
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(admitted.stdout.trim(), "admitted");
  });

  it("releases an active-client slot when its owning process exits", () => {
    const targetHome = home("process-exit");
    const first = probe(targetHome, 1);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), "admitted");

    const afterExit = probe(targetHome, 1);
    assert.equal(afterExit.status, 0, afterExit.stderr);
    assert.equal(afterExit.stdout.trim(), "admitted");
  });

  it("counts active client processes across separate homes for the same OS user", () => {
    const firstHome = home("home-one");
    const secondHome = home("home-two");
    const first = acquireClientLease(firstHome, { maxActiveClients: 1 });
    try {
      assert.throws(
        () => acquireClientLease(secondHome, { maxActiveClients: 1 }),
        /active client limit \(1\) reached/,
      );
    } finally {
      releaseClientLease(first);
    }
  });

  it("fails closed when active processes disagree on the shared capacity", () => {
    const targetHome = home("capacity-mismatch");
    const lease = acquireClientLease(targetHome, { maxActiveClients: 2 });
    try {
      const mismatched = probe(targetHome, 1);
      assert.equal(mismatched.status, 0, mismatched.stderr);
      assert.equal(mismatched.stdout.trim(), "ResourceAdmissionConflictError");
    } finally {
      releaseClientLease(lease);
    }
  });

  it("rejects a zero client limit before acquiring a home lease", () => {
    const targetHome = home("invalid-limit");
    assert.throws(
      () => acquireClientLease(targetHome, { maxActiveClients: 0 }),
      /expected an integer from 1 to 64/,
    );
    const valid = acquireClientLease(targetHome, { maxActiveClients: 1 });
    releaseClientLease(valid);
  });
});
