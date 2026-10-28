import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withOperatorConfig(contents: string, run: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operator-config-startup-"));
  const configDir = path.join(home, ".config", "nexus");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), contents);
  try {
    run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runCli(home: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), ...args], {
    cwd: cliDir,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    encoding: "utf8",
    input,
    timeout: 15_000,
  });
}

function runDoctorWithOperatorConfigIoFailure(home: string, method: "lstatSync" | "openSync") {
  const target = path.join(home, ".config", "nexus", "config.json");
  const indexPath = path.join(cliDir, "src", "index.ts");
  const script = `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = ${JSON.stringify(target)};
    const original = fs.default.${method}.bind(fs.default);
    fs.default.${method} = (candidate, ...args) => {
      if (path.resolve(String(candidate)) === target) {
        throw Object.assign(new Error("synthetic operator config access failure"), { code: "EACCES" });
      }
      return original(candidate, ...args);
    };
    process.argv = [process.execPath, ${JSON.stringify(indexPath)}, "doctor", "--json", "--timeout", "50"];
    await import(${JSON.stringify(pathToFileURL(indexPath).href)});
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: cliDir,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("doctor reports malformed operator config as an actionable text finding", () => {
  withOperatorConfig("{broken", (home) => {
    const result = runCli(home, ["doctor", "--timeout", "50"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /FAIL config\.valid:/);
    assert.match(result.stdout, /config\.json is not valid JSON/);
    assert.match(result.stdout, /Inspect ~\/\.config\/nexus\/config\.json/);
    assert.match(result.stdout, /runtime\.node:/, "independent checks should still be reported");
  });
});

test("doctor reports unsupported operator policy in JSON without treating it as defaults", () => {
  withOperatorConfig(JSON.stringify({ version: 1, operationPolicy: { hiddenDefault: 2 } }), (home) => {
    const result = runCli(home, ["doctor", "--json", "--timeout", "50"]);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    const finding = report.findings.find((item: { id: string }) => item.id === "config.valid");
    assert.equal(finding.status, "fail");
    assert.match(finding.evidence[0], /Unsupported Nexus config\.json operationPolicy field 'hiddenDefault'/);
    assert.match(finding.action, /~\/\.config\/nexus\/config\.json/);
  });
});

test("doctor gives config.json repair guidance for read and inspection failures", () => {
  withOperatorConfig("{}", (home) => {
    for (const method of ["lstatSync", "openSync"] as const) {
      const result = runDoctorWithOperatorConfigIoFailure(home, method);
      assert.equal(result.status, 2, result.stderr);
      const report = JSON.parse(result.stdout);
      const finding = report.findings.find((item: { id: string }) => item.id === "config.valid");
      assert.equal(finding.status, "fail");
      assert.match(
        finding.evidence[0],
        method === "lstatSync"
          ? /Unable to inspect the operator config\.json file/
          : /Unable to read the operator config\.json file/,
      );
      assert.match(finding.action, /Inspect ~\/\.config\/nexus\/config\.json/);
    }
  });
});

test("ordinary CLI startup rejects invalid policy before launching a session", () => {
  withOperatorConfig(JSON.stringify({ version: 1, operationPolicy: { maxWaitMs: 0 } }), (home) => {
    const result = runCli(home, ["--repl"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Configuration error: Invalid Nexus config\.json operationPolicy\.maxWaitMs/);
    assert.doesNotMatch(result.stderr, /stack|Unhandled/);
  });
});

test("non-doctor commands cannot bypass invalid config with option values or nested arguments", () => {
  withOperatorConfig("{broken", (home) => {
    for (const args of [
      ["-w", "check", "skills"],
      ["-w", "doctor", "skills"],
      ["trust", "check"],
      ["run", "doctor", "check"],
    ]) {
      const result = runCli(home, args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /Configuration error: Nexus config\.json is not valid JSON/);
    }
  });
});

test("doctor remains available after root options when operator config is invalid", () => {
  withOperatorConfig("{broken", (home) => {
    const result = runCli(home, ["--provider", "openrouter", "doctor", "--json", "--timeout", "50"]);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    const finding = report.findings.find((item: { id: string }) => item.id === "config.valid");
    assert.equal(finding.status, "fail");
    assert.match(finding.evidence[0], /config\.json is not valid JSON/);
  });
});

test("interactive REPL exits successfully when stdin reaches EOF", () => {
  withOperatorConfig('{"version": 1}', (home) => {
    const result = runCli(home, ["--repl", "--endpoint", "http://127.0.0.1:9"], "");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  });
});

test("direct TUI sidecar startup rejects malformed operator policy before opening the protocol", () => {
  withOperatorConfig("not-json", (home) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/sidecar.ts")], {
      cwd: cliDir,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
      encoding: "utf8",
      timeout: 15_000,
      input: "",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nexus sidecar failed to start: Configuration error: Nexus config\.json is not valid JSON/);
    assert.equal(result.stdout, "", "startup diagnostics must not corrupt the TUI protocol stream");
  });
});
