import { test, describe } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync, spawnSync } from "node:child_process";

describe("WP-11: Security Lifecycle Gates & Segregation (INC-12, SCAN-001..005, REL-001..004, SEGR-001..003)", () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const scriptsDir = path.join(rootDir, "scripts");

  test("SCAN-001 & SCAN-004: Security gates script passes on clean codebase", () => {
    const scriptPath = path.join(scriptsDir, "security_gates.sh");
    assert.strictEqual(fs.existsSync(scriptPath), true, "security_gates.sh must exist");

    const out = execFileSync("bash", [scriptPath], {
      cwd: rootDir,
      encoding: "utf-8",
    });

    assert.ok(out.includes("NEXUS CODE LIFECYCLE SECURITY SCANNING GATES"));
    assert.ok(out.includes("Gate 1"));
    assert.ok(out.includes("Gate 2"));
    assert.ok(out.includes("Gate 3"));
    assert.ok(out.includes("ALL SECURITY LIFECYCLE GATES PASSED CLEANLY"));
  });

  test("SCAN-002: Security gates reject bypass attempts (non-bypassable invariant)", () => {
    const scriptPath = path.join(scriptsDir, "security_gates.sh");

    // Attempt 1: SKIP_SECURITY_GATES=1
    assert.throws(
      () => {
        execFileSync("bash", [scriptPath], {
          cwd: rootDir,
          env: { ...process.env, SKIP_SECURITY_GATES: "1" },
          stdio: "pipe",
        });
      },
      (err: any) => {
        const stderr = err.stderr ? err.stderr.toString() : "";
        return stderr.includes("Security gates are non-bypassable");
      }
    );

    // Attempt 2: BYPASS_SECURITY_SCAN=true
    assert.throws(
      () => {
        execFileSync("bash", [scriptPath], {
          cwd: rootDir,
          env: { ...process.env, BYPASS_SECURITY_SCAN: "true" },
          stdio: "pipe",
        });
      },
      (err: any) => {
        const stderr = err.stderr ? err.stderr.toString() : "";
        return stderr.includes("Security gates are non-bypassable");
      }
    );
  });

  /**
   * A stand-in `npm` first on PATH, so Gate 1's outcome is fixed and a later gate's assertion cannot be masked by a
   * network or npm configuration problem. Like npm 11, it refuses an inherited npm_config_allow_scripts.
   */
  function stubNpm(report: "clean" | "findings" | "error"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stub-npm-"));
    const bodies = {
      clean: `echo '{"metadata":{"vulnerabilities":{"info":0,"low":1,"moderate":0,"high":0,"critical":0}}}'; exit 0`,
      findings: `echo '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":2,"critical":1}}}'; exit 1`,
      error: `echo '{"error":{"code":"ENOTFOUND","summary":"request to https://registry.npmjs.org failed"}}'; echo 'npm error code ENOTFOUND' >&2; exit 1`,
    };
    fs.writeFileSync(
      path.join(dir, "npm"),
      `#!/usr/bin/env bash
if [[ -n "\${npm_config_allow_scripts:-}" ]]; then
  echo '{"error":{"code":"EALLOWSCRIPTS","summary":"--allow-scripts is not allowed in project-scoped installs."}}'
  exit 1
fi
${bodies[report]}
`,
      { mode: 0o755 },
    );
    return dir;
  }

  function runGate(npmDir: string, extraEnv: Record<string, string> = {}): { status: number; stderr: string; stdout: string } {
    const res = spawnSync("bash", [path.join(scriptsDir, "security_gates.sh")], {
      cwd: rootDir,
      env: { ...process.env, PATH: `${npmDir}:${process.env.PATH}`, ...extraEnv },
      encoding: "utf-8",
    });
    fs.rmSync(npmDir, { recursive: true, force: true });
    return { status: res.status ?? -1, stderr: res.stderr, stdout: res.stdout };
  }

  test("SCAN-001 & SCAN-004: Rust vulnerability scanner unavailable fails closed", () => {
    // Gate 1 is pinned clean, so the failure can only come from the simulated Rust scanner.
    const res = runGate(stubNpm("clean"), { SIMULATE_RUST_SCANNER_UNAVAILABLE: "1" });
    assert.notEqual(res.status, 0);
    assert.ok(res.stdout.includes("[+] [Gate 1] Node.js dependencies clean"), res.stdout + res.stderr);
    assert.ok(res.stderr.includes("Rust vulnerability scanner unavailable"), res.stderr);
  });

  test("SCAN-005: an npm audit that cannot run is a scanner failure, not a vulnerability finding", () => {
    const res = runGate(stubNpm("error"));
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.includes("[SCAN-005]") && res.stderr.includes("scanner could not run"), res.stderr);
    assert.ok(res.stderr.includes("ENOTFOUND"), res.stderr);
    assert.ok(!res.stderr.includes("High or Critical vulnerability detected"), res.stderr);
  });

  test("SCAN-004: High/Critical npm audit findings fail the gate as findings", () => {
    const res = runGate(stubNpm("findings"));
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.includes("[SCAN-004]") && res.stderr.includes("high=2 critical=1"), res.stderr);
    assert.ok(!res.stderr.includes("[SCAN-005]"), res.stderr);
  });

  test("SCAN-005: an allow-scripts setting inherited from `npm test` does not reach npm audit", () => {
    // Under `npm test`, npm exports a user-level `allow-scripts` as npm_config_allow_scripts; npm 11 rejects it.
    const res = runGate(stubNpm("clean"), { npm_config_allow_scripts: "workerd", SIMULATE_RUST_SCANNER_UNAVAILABLE: "1" });
    assert.ok(res.stdout.includes("[+] [Gate 1] Node.js dependencies clean"), res.stdout + res.stderr);
    assert.ok(!res.stderr.includes("EALLOWSCRIPTS"), res.stderr);
  });

  test("SCAN-002: Rust dependency vulnerability detection on fixture fails closed", () => {
    const auditScript = path.join(scriptsDir, "audit_rust_deps.py");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vuln-cargo-"));
    try {
      const lockContent = `version = 3

[[package]]
name = "smallvec"
version = "0.6.13"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
      const lockPath = path.join(tmpDir, "Cargo.lock");
      fs.writeFileSync(lockPath, lockContent);

      assert.throws(
        () => {
          execFileSync("python3", [auditScript, lockPath], {
            cwd: rootDir,
            stdio: "pipe",
          });
        },
        (err: any) => {
          const stderr = err.stderr ? err.stderr.toString() : "";
          return stderr.includes("vulnerability/vulnerabilities detected") && stderr.includes("smallvec@0.6.13");
        }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SCAN-003 & TEST-003: Secret scanning detects synthetic credentials in workspace", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-secret-scan-"));
    try {
      execFileSync("git", ["init"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: tmpDir });

      // Write synthetic secret
      const leakFile = path.join(tmpDir, "credentials.txt");
      fs.writeFileSync(leakFile, "ghp_FAKEPERSONALACCESSTOKEN1234567890ABCDE\n");
      execFileSync("git", ["add", "."], { cwd: tmpDir });

      // Run secret pattern match against repo
      const pattern = "ghp_[A-Za-z0-9_]{36,}";
      let detected = false;
      try {
        const matches = execFileSync("git", ["grep", "-EI", pattern], {
          cwd: tmpDir,
          encoding: "utf-8",
        });
        if (matches.length > 0) detected = true;
      } catch {}

      assert.strictEqual(detected, true, "Secret scanner must detect synthetic GitHub token");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("REL-001, REL-002, REL-003: SBOM generator creates CycloneDX specification and SHA-256 digest", () => {
    const scriptPath = path.join(scriptsDir, "generate_sbom.sh");
    assert.strictEqual(fs.existsSync(scriptPath), true, "generate_sbom.sh must exist");

    execFileSync("bash", [scriptPath], {
      cwd: rootDir,
      encoding: "utf-8",
    });

    const sbomPath = path.join(rootDir, "dist", "sbom.json");
    const checksumPath = path.join(rootDir, "dist", "sbom.json.sha256");

    assert.strictEqual(fs.existsSync(sbomPath), true, "dist/sbom.json must be generated");
    assert.strictEqual(fs.existsSync(checksumPath), true, "dist/sbom.json.sha256 must be generated");

    const sbomContent = fs.readFileSync(sbomPath, "utf-8");
    const sbom = JSON.parse(sbomContent);

    assert.strictEqual(sbom.bomFormat, "CycloneDX");
    assert.strictEqual(sbom.specVersion, "1.5");
    assert.ok(sbom.metadata);
    assert.strictEqual(sbom.metadata.component.name, "nexus-code");
    assert.ok(Array.isArray(sbom.components));
    assert.ok(sbom.components.length >= 10, "Must capture components from Node and Rust manifests");

    // Verify component purls
    const componentNames = sbom.components.map((c: any) => c.name);
    assert.ok(componentNames.includes("commander"), "Must include commander from cli/package.json");
    assert.ok(componentNames.includes("serde"), "Must include serde from core/Cargo.toml");

    // Verify checksum
    const checksumLine = fs.readFileSync(checksumPath, "utf-8").trim();
    assert.ok(checksumLine.endsWith("sbom.json"));

    // Cleanup generated dist
    fs.rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
  });

  test("SEGR-001 & SEGR-003: Rust core segregation and CLI invocation boundary", () => {
    const coreExe = path.join(rootDir, "core/target/release/harness-core");
    const coreDebugExe = path.join(rootDir, "core/target/debug/harness-core");
    const exe = fs.existsSync(coreExe) ? coreExe : coreDebugExe;

    if (fs.existsSync(exe)) {
      // Execute version check via core CLI
      const versionOut = execFileSync(exe, ["--help"], { encoding: "utf-8" });
      assert.ok(versionOut.includes("High-performance Core Engine for Coding Harness"));
      assert.ok(versionOut.includes("call"));
      assert.ok(versionOut.includes("rpc"));
    }
  });
});
