import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "check_requirements.mjs");
const isolatedHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-requirements-home-"));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8",
  env: { ...process.env, HOME: isolatedHome() },
});

function ledger(row: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ledger-"));
  const file = path.join(dir, "REQUIREMENTS.md");
  fs.writeFileSync(file, [
    "| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    row,
    "",
  ].join("\n"));
  return file;
}

function rcEvidenceFixture(ledgerStatus = "tested") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rc-requirements-"));
  const supportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rc-evidence-"));
  const home = path.join(supportRoot, "home");
  const repoScript = path.join(root, "scripts", "check_requirements.mjs");
  const evidenceRoot = path.join(supportRoot, "evidence");
  const artifactPath = path.join(supportRoot, "nexus-v1.0.0-rc.1.tar.gz");
  const recordPath = path.join(supportRoot, "rc-acceptance.json");
  const ledgerPath = path.join(root, "docs", "v1.0.0", "REQUIREMENTS.md");

  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(repoScript), { recursive: true });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "v1.0.0", "specs"), { recursive: true });
  fs.mkdirSync(evidenceRoot);
  fs.copyFileSync(script, repoScript);
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "ACCEPTANCE.md"), "| ACC-SAFE-01 | fixture acceptance |\n");
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "DECISIONS.md"), "## DEC-99: Fixture scope decision\n");
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "specs", "SPEC-01.md"), "| ACC-SAFE-01 | fixture |\n");
  fs.writeFileSync(ledgerPath, [
    "| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    `| REQ-SEC-101 | x | x | x | x | x | ${ledgerStatus} | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |`,
    "",
  ].join("\n"));

  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Requirements Fixture");
  git("config", "user.email", "requirements-fixture@example.invalid");
  git("add", "scripts", "docs");
  git("commit", "--quiet", "-m", "fixture source");
  const sourceCommit = git("rev-parse", "HEAD");
  git("tag", "v1.0.0-rc.1");

  fs.writeFileSync(artifactPath, "synthetic immutable RC artifact\n");
  const evidenceFile = path.join(evidenceRoot, "t2-qualification.json");
  fs.writeFileSync(evidenceFile, JSON.stringify({ disposition: "PASS", tasks: 40 }));
  const reportFile = path.join(evidenceRoot, "independent-acceptance.md");
  fs.writeFileSync(reportFile, "Independent ACCEPT for the exact synthetic fixture candidate.\n");
  const provenanceFile = path.join(evidenceRoot, "build-provenance.json");
  const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(provenanceFile, JSON.stringify({ sourceCommit, artifactSha256: sha256(artifactPath) }));
  const record = {
    schemaVersion: 1,
    sourceCommit,
    rcTag: "v1.0.0-rc.1",
    artifactSha256: sha256(artifactPath),
    artifactProvenance: {
      sourceCommit,
      artifactSha256: sha256(artifactPath),
      path: "build-provenance.json",
      sha256: sha256(provenanceFile),
    },
    independentAcceptance: {
      disposition: "ACCEPT",
      reviewer: "independent-reviewer",
      implementers: ["implementer"],
      blockingDefects: 0,
      report: { path: "independent-acceptance.md", sha256: sha256(reportFile) },
    },
    requirements: {
      "REQ-SEC-101": {
        status: "product-qualified",
        evidence: [{ id: "ACC-SAFE-01", path: "t2-qualification.json", sha256: sha256(evidenceFile) }],
      },
    },
  };
  fs.writeFileSync(recordPath, JSON.stringify(record));

  const runFixture = (...args: string[]) => spawnSync(process.execPath, [repoScript, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  const enforcedArgs = [
    "--enforce",
    "--qualification-record", recordPath,
    "--rc-artifact", artifactPath,
    "--evidence-root", evidenceRoot,
  ];
  return { root, supportRoot, record, recordPath, artifactPath, evidenceRoot, sourceCommit, runFixture, enforcedArgs };
}

// REQ-OPS-102 / ACC-GOV-01
test("the ledger checker passes the repository ledger in report mode", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the ledger checker rejects a test reference whose test does not exist", () => {
  const file = ledger('| REQ-SEC-101 | x | x | x | x | test:cli/test/config.test.ts::"no such test name" | tested | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |');
  const result = run("--ledger", file);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not found/);
});

test("the ledger checker rejects a blocker without spec, plan or acceptance, and an undefined acceptance id", () => {
  assert.equal(run("--ledger", ledger("| REQ-SEC-101 | x | x | x | x | x | open | — | **B** | x | — |")).status, 1);
  const undefinedAcc = run("--ledger", ledger("| REQ-SEC-101 | x | x | x | x | x | open | ACC-NOPE-01 | **B** | x | SPEC-01 / PLAN-01 |"));
  assert.match(undefinedAcc.stdout, /ACC-NOPE-01 is not defined/);
});

test("enforce mode requires blocker rows to be tested", () => {
  const file = ledger('| REQ-SEC-101 | x | x | x | x | test:cli/test/config.test.ts::"buildConfig applies flags" | open | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |');
  assert.equal(run("--ledger", file).status, 0);
  const enforced = run("--ledger", file, "--enforce");
  assert.equal(enforced.status, 1);
  assert.match(enforced.stdout, /below 'tested'/);
});

test("exact-RC qualification evidence satisfies enforce without changing the source ledger", () => {
  const fixture = rcEvidenceFixture();
  const result = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /qualification evidence verified for v1\.0\.0-rc\.1/);
  assert.equal(fixture.record.sourceCommit, fixture.sourceCommit);
});

test("exact-RC evidence cannot bypass a below-tested source ledger or a dirty worktree", () => {
  const belowTested = rcEvidenceFixture("open");
  const belowResult = belowTested.runFixture(...belowTested.enforcedArgs);
  assert.equal(belowResult.status, 1);
  assert.match(belowResult.stdout, /source ledger status 'open' is below 'tested'/);

  const dirty = rcEvidenceFixture();
  fs.writeFileSync(path.join(dirty.root, "uncommitted-requirements-change.txt"), "untracked source change\n");
  assert.match(dirty.runFixture(...dirty.enforcedArgs).stdout, /requires a clean source worktree/);
});

test("exact-RC qualification evidence rejects a caller-supplied ledger and mismatched build provenance", () => {
  const ledgerOverride = rcEvidenceFixture();
  assert.match(ledgerOverride.runFixture("--ledger", path.join(ledgerOverride.root, "docs", "v1.0.0", "REQUIREMENTS.md"), ...ledgerOverride.enforcedArgs).stdout, /--ledger cannot be used/);

  const provenanceMismatch = rcEvidenceFixture();
  provenanceMismatch.record.artifactProvenance.sourceCommit = "f".repeat(40);
  fs.writeFileSync(provenanceMismatch.recordPath, JSON.stringify(provenanceMismatch.record));
  assert.match(provenanceMismatch.runFixture(...provenanceMismatch.enforcedArgs).stdout, /artifact provenance does not bind/);
});

test("a blocker marked tested needs a recorded, approved qualification exception", () => {
  const fixture = rcEvidenceFixture();
  fixture.record.requirements["REQ-SEC-101"].status = "tested";
  fixture.record.requirements["REQ-SEC-101"].qualificationNotApplicable = {
    reason: "The approved scope limits this criterion to source-level verification.",
    decision: "DEC-99",
  };
  fs.writeFileSync(fixture.recordPath, JSON.stringify(fixture.record));
  assert.equal(fixture.runFixture(...fixture.enforcedArgs).status, 0);

  delete fixture.record.requirements["REQ-SEC-101"].qualificationNotApplicable.decision;
  fs.writeFileSync(fixture.recordPath, JSON.stringify(fixture.record));
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /approved decision and qualification-not-applicable reason/);
});

test("exact-RC qualification evidence fails when source, tag, or artifact identity differs", () => {
  const sourceMismatch = rcEvidenceFixture();
  sourceMismatch.record.sourceCommit = "f".repeat(40);
  fs.writeFileSync(sourceMismatch.recordPath, JSON.stringify(sourceMismatch.record));
  assert.match(sourceMismatch.runFixture(...sourceMismatch.enforcedArgs).stdout, /source commit does not match/);

  const artifactMismatch = rcEvidenceFixture();
  fs.writeFileSync(artifactMismatch.artifactPath, "different artifact\n");
  assert.match(artifactMismatch.runFixture(...artifactMismatch.enforcedArgs).stdout, /artifact SHA-256 does not match/);

  const tagMismatch = rcEvidenceFixture();
  tagMismatch.record.rcTag = "v1.0.0-rc.2";
  fs.writeFileSync(tagMismatch.recordPath, JSON.stringify(tagMismatch.record));
  assert.match(tagMismatch.runFixture(...tagMismatch.enforcedArgs).stdout, /does not point to the current source commit/);
});

test("exact-RC qualification evidence fails without independent acceptance or complete required rows", () => {
  const selfReview = rcEvidenceFixture();
  selfReview.record.independentAcceptance.reviewer = "implementer";
  fs.writeFileSync(selfReview.recordPath, JSON.stringify(selfReview.record));
  assert.match(selfReview.runFixture(...selfReview.enforcedArgs).stdout, /reviewer must be independent/);

  const caseVariantSelfReview = rcEvidenceFixture();
  caseVariantSelfReview.record.independentAcceptance.reviewer = "IMPLEMENTER";
  fs.writeFileSync(caseVariantSelfReview.recordPath, JSON.stringify(caseVariantSelfReview.record));
  assert.match(caseVariantSelfReview.runFixture(...caseVariantSelfReview.enforcedArgs).stdout, /reviewer must be independent/);

  const missingRequirement = rcEvidenceFixture();
  missingRequirement.record.requirements = {};
  fs.writeFileSync(missingRequirement.recordPath, JSON.stringify(missingRequirement.record));
  assert.match(missingRequirement.runFixture(...missingRequirement.enforcedArgs).stdout, /missing qualification evidence for REQ-SEC-101/);

  const blockerDefect = rcEvidenceFixture();
  blockerDefect.record.independentAcceptance.blockingDefects = 1;
  fs.writeFileSync(blockerDefect.recordPath, JSON.stringify(blockerDefect.record));
  assert.match(blockerDefect.runFixture(...blockerDefect.enforcedArgs).stdout, /unresolved blocker defects/);

  const unresolvedNonBlocker = rcEvidenceFixture();
  unresolvedNonBlocker.record.independentAcceptance.disposition = "ACCEPT WITH DEFECTS";
  Object.assign(unresolvedNonBlocker.record.independentAcceptance, { defects: [{ id: "DEF-1", blocking: false }] });
  fs.writeFileSync(unresolvedNonBlocker.recordPath, JSON.stringify(unresolvedNonBlocker.record));
  assert.match(unresolvedNonBlocker.runFixture(...unresolvedNonBlocker.enforcedArgs).stdout, /non-blocking owner dispositions/);
});

test("exact-RC qualification evidence rejects symlinked evidence files", () => {
  const fixture = rcEvidenceFixture();
  const source = path.join(fixture.evidenceRoot, "t2-qualification.json");
  const target = path.join(fixture.supportRoot, "outside-evidence.json");
  fs.renameSync(source, target);
  fs.symlinkSync(target, source);
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /evidence path must contain only directories and a regular file/);
});
