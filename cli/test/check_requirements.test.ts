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

function rcEvidenceFixture(ledgerStatus = "tested", options: {
  requirementId?: string;
  acceptanceCell?: string;
  evidenceIds?: string[];
  qualificationOnly?: boolean;
  requirementClass?: string;
  qualificationStatus?: string;
} = {}) {
  const requirementId = options.requirementId ?? "REQ-SEC-101";
  const evidenceIds = options.evidenceIds ?? ["ACC-SAFE-01"];
  const acceptanceCell = options.acceptanceCell ?? evidenceIds.join(", ");
  const qualificationMap = options.qualificationOnly
    ? `| ${requirementId} | ${evidenceIds.join(", ")} | Fixture criterion requires exact-RC qualification |\n`
    : "";
  const exceptionMap = requirementId === "REQ-SEC-101" && !options.qualificationOnly
    ? "| REQ-SEC-101 | DEC-99 | Explicitly approved fixture-only exception |\n"
    : "";
  const exceptionDecision = exceptionMap
    ? "## DEC-99: Fixture scope decision\n\n- Qualification applicability: REQ-SEC-101 = NOT REQUIRED (source-only).\n"
    : "## DEC-99: Unused fixture decision\n";
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
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "ACCEPTANCE.md"), [
    "| ACC-SAFE-01 | fixture acceptance |",
    "| ACC-QUAL-T2 | fixture exact-RC qualification |",
    "| ACC-CONT-10 | fixture continuity qualification |",
    "| ACC-GOV-06 | fixture independent acceptance |",
    "| ACC-PKG-01 | fixture exact criterion identifier |",
    "| ACC-PLAT | fixture supported platform criterion |",
    "<!-- RC-QUALIFICATION-ONLY:START -->",
    qualificationMap,
    "<!-- RC-QUALIFICATION-ONLY:END -->",
    "<!-- RC-QUALIFICATION-EXCEPTIONS:START -->",
    exceptionMap,
    "<!-- RC-QUALIFICATION-EXCEPTIONS:END -->",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "DECISIONS.md"), exceptionDecision);
  fs.writeFileSync(path.join(root, "docs", "v1.0.0", "specs", "SPEC-01.md"), "| ACC-SAFE-01 | fixture |\n");
  fs.writeFileSync(ledgerPath, [
    "| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${requirementId} | x | x | x | x | x | ${ledgerStatus} | ${acceptanceCell} | ${options.requirementClass ?? "**B**"} | x | SPEC-01 / PLAN-01 |`,
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
  const commitSource = () => {
    git("add", "docs");
    git("commit", "--quiet", "--allow-empty", "-m", "fixture source update");
    return git("rev-parse", "HEAD");
  };
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
      [requirementId]: {
        status: options.qualificationStatus ?? "product-qualified",
        evidence: evidenceIds.map((id) => ({ id, path: "t2-qualification.json", sha256: sha256(evidenceFile) })),
      },
    },
  };
  fs.writeFileSync(recordPath, JSON.stringify(record));

  const refreshCandidateIdentity = () => {
    const nextCommit = commitSource();
    git("tag", "--force", "v1.0.0-rc.1", nextCommit);
    record.sourceCommit = nextCommit;
    record.artifactProvenance.sourceCommit = nextCommit;
    fs.writeFileSync(provenanceFile, JSON.stringify({ sourceCommit: nextCommit, artifactSha256: sha256(artifactPath) }));
    record.artifactProvenance.sha256 = sha256(provenanceFile);
    fs.writeFileSync(recordPath, JSON.stringify(record));
  };

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
  return { root, supportRoot, record, recordPath, artifactPath, evidenceRoot, sourceCommit, commitSource, refreshCandidateIdentity, runFixture, enforcedArgs };
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

test("the ledger checker rejects duplicate requirement IDs instead of overwriting a blocker", () => {
  const row = '| REQ-SEC-101 | x | x | x | x | x | open | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |';
  const file = ledger(row);
  fs.appendFileSync(file, row.replace(" open |", " tested |"));

  const result = run("--ledger", file, "--enforce");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REQ-SEC-101: duplicate requirement ID in ledger/);
  assert.match(result.stdout, /REQ-SEC-101: source ledger status 'open' is below 'tested'/);
});

test("exact-RC enforcement rejects a duplicate blocker even when its later row is tested", () => {
  const fixture = rcEvidenceFixture("open", {
    requirementId: "REQ-QUAL-101",
    acceptanceCell: "ACCEPTANCE §6.1",
    evidenceIds: ["ACC-QUAL-T2"],
    qualificationOnly: true,
  });
  const ledgerPath = path.join(fixture.root, "docs", "v1.0.0", "REQUIREMENTS.md");
  const firstRow = fs.readFileSync(ledgerPath, "utf8").split("\n").find((line) => line.startsWith("| REQ-QUAL-101 |"));
  assert.ok(firstRow);
  fs.appendFileSync(ledgerPath, firstRow.replace(" open |", " tested |"));
  fixture.refreshCandidateIdentity();

  const result = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REQ-QUAL-101: duplicate requirement ID in ledger/);
});

test("exact-RC qualification evidence satisfies enforce without changing the source ledger", () => {
  const fixture = rcEvidenceFixture();
  const result = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /qualification evidence verified for v1\.0\.0-rc\.1/);
  assert.equal(fixture.record.sourceCommit, fixture.sourceCommit);
});

test("exact-RC evidence resolves a mapped qualification-only row without rewriting its source status", () => {
  const fixture = rcEvidenceFixture("open", {
    requirementId: "REQ-QUAL-101",
    acceptanceCell: "ACCEPTANCE §6.1",
    evidenceIds: ["ACC-QUAL-T2"],
    qualificationOnly: true,
  });
  const exactRc = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(exactRc.status, 0, exactRc.stdout + exactRc.stderr);
  assert.match(exactRc.stdout, /qualification evidence verified for v1\.0\.0-rc\.1/);
  assert.equal(fixture.record.requirements["REQ-QUAL-101"].status, "product-qualified");

  const beforeQualification = fixture.runFixture("--enforce");
  assert.equal(beforeQualification.status, 0, beforeQualification.stdout + beforeQualification.stderr);
  assert.match(beforeQualification.stdout, /deferred to exact-RC qualification: REQ-QUAL-101 \(open\)/);

  fixture.record.requirements["REQ-QUAL-101"].status = "tested";
  fixture.record.requirements["REQ-QUAL-101"].qualificationNotApplicable = {
    reason: "An exception cannot replace the required installed-RC qualification.",
    decision: "DEC-99",
  };
  fs.writeFileSync(fixture.recordPath, JSON.stringify(fixture.record));
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /exact-RC qualification requires product-qualified status/);
});

test("pre-RC enforcement defers only requirements explicitly mapped to exact-RC qualification", () => {
  const mapped = rcEvidenceFixture("open", {
    requirementId: "REQ-QUAL-101",
    acceptanceCell: "ACCEPTANCE §6.1",
    evidenceIds: ["ACC-QUAL-T2"],
    qualificationOnly: true,
  });
  assert.equal(mapped.runFixture("--enforce").status, 0);

  const sourceTestedButRcPending = rcEvidenceFixture("tested", {
    requirementId: "REQ-QUAL-101",
    acceptanceCell: "ACCEPTANCE §6.1",
    evidenceIds: ["ACC-QUAL-T2"],
    qualificationOnly: true,
  });
  const preRc = sourceTestedButRcPending.runFixture("--enforce");
  assert.equal(preRc.status, 0, preRc.stdout + preRc.stderr);
  assert.match(preRc.stdout, /deferred to exact-RC qualification: REQ-QUAL-101 \(tested\)/);

  const unmapped = rcEvidenceFixture("open");
  const result = unmapped.runFixture("--enforce");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REQ-SEC-101: source ledger status 'open' is below 'tested'/);
});

test("authoritative pre-RC enforcement rejects a dirty source worktree", () => {
  const fixture = rcEvidenceFixture("open", {
    requirementId: "REQ-QUAL-101",
    acceptanceCell: "ACCEPTANCE §6.1",
    evidenceIds: ["ACC-QUAL-T2"],
    qualificationOnly: true,
  });
  fs.writeFileSync(path.join(fixture.root, "uncommitted-acceptance-change.txt"), "uncommitted source change\n");

  const result = fixture.runFixture("--enforce");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /pre-RC enforcement requires a clean source worktree/);
});

test("unrecognized and inherited source status names cannot be hidden by the qualification-only map", () => {
  for (const status of ["unknown", "__proto__", "toString"]) {
    const fixture = rcEvidenceFixture(status, {
      requirementId: "REQ-QUAL-101",
      acceptanceCell: "ACCEPTANCE §6.1",
      evidenceIds: ["ACC-QUAL-T2"],
      qualificationOnly: true,
    });
    assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, new RegExp(`source ledger status '${status}' is not recognized`));
  }
});

test("exact-RC evidence must meet the RR threshold and cover every mapped criterion", () => {
  const fixture = rcEvidenceFixture("partial", {
    requirementId: "REQ-AGT-110",
    acceptanceCell: "ACC-CONT-10, ACC-GOV-06",
    evidenceIds: ["ACC-CONT-10", "ACC-GOV-06"],
    qualificationOnly: true,
    requirementClass: "RR",
    qualificationStatus: "tested",
  });
  const complete = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);

  fixture.record.requirements["REQ-AGT-110"].evidence.pop();
  fs.writeFileSync(fixture.recordPath, JSON.stringify(fixture.record));
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /must cover every acceptance criterion/);
});

test("exact-RC evidence accepts the declared single-segment platform criterion", () => {
  const fixture = rcEvidenceFixture("tested", {
    requirementId: "REQ-REL-003",
    requirementClass: "RR",
    acceptanceCell: "ACC-PLAT",
    evidenceIds: ["ACC-PLAT"],
  });
  const result = fixture.runFixture(...fixture.enforcedArgs);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("exact-RC evidence rejects undefined and malformed platform criterion lookalikes", () => {
  for (const id of ["ACC-UNKNOWN", "ACC-PLAT-extra", "ACC-PLAT-", "ACC-PLAT_suffix"]) {
    const fixture = rcEvidenceFixture("tested", {
      requirementId: "REQ-REL-003",
      requirementClass: "RR",
      acceptanceCell: id,
      evidenceIds: [id],
    });
    const result = fixture.runFixture(...fixture.enforcedArgs);
    assert.notEqual(result.status, 0, `${id}: ${result.stdout}${result.stderr}`);
  }
});

test("exact-RC evidence requires exact acceptance identifiers", () => {
  const fixture = rcEvidenceFixture("tested", {
    acceptanceCell: "ACC-PKG-01",
    evidenceIds: ["ACC-PKG-0"],
  });
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /must cover every acceptance criterion/);
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

  const genericDecision = rcEvidenceFixture();
  genericDecision.record.requirements["REQ-SEC-101"].status = "tested";
  genericDecision.record.requirements["REQ-SEC-101"].qualificationNotApplicable = {
    reason: "A matching but unapproved decision cannot authorize this requirement exception.",
    decision: "DEC-98",
  };
  fs.writeFileSync(path.join(genericDecision.root, "docs", "v1.0.0", "DECISIONS.md"), "## DEC-98: Unapproved generic fixture decision\n\n- Qualification applicability: REQ-SEC-101 = NOT REQUIRED (source-only).\n");
  genericDecision.refreshCandidateIdentity();
  assert.match(genericDecision.runFixture(...genericDecision.enforcedArgs).stdout, /approved decision and qualification-not-applicable reason/);

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

  const missingImplementers = rcEvidenceFixture();
  missingImplementers.record.independentAcceptance.implementers = [];
  fs.writeFileSync(missingImplementers.recordPath, JSON.stringify(missingImplementers.record));
  assert.match(missingImplementers.runFixture(...missingImplementers.enforcedArgs).stdout, /identified implementers/);

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

test("exact-RC evidence covers every acceptance criterion listed on each required ledger row", () => {
  const fixture = rcEvidenceFixture();
  const secondAcc = "ACC-SAFE-02";
  const acceptancePath = path.join(fixture.root, "docs", "v1.0.0", "ACCEPTANCE.md");
  const specPath = path.join(fixture.root, "docs", "v1.0.0", "specs", "SPEC-01.md");
  const ledgerPath = path.join(fixture.root, "docs", "v1.0.0", "REQUIREMENTS.md");
  fs.appendFileSync(acceptancePath, `| ${secondAcc} | second fixture acceptance |\n`);
  fs.appendFileSync(specPath, `| ${secondAcc} | fixture |\n`);
  fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, "utf8").replace("ACC-SAFE-01 | **B**", "ACC-SAFE-01 to ACC-SAFE-02 | **B**"));
  fixture.refreshCandidateIdentity();
  fixture.record.requirements["REQ-SEC-101"].evidence.push(fixture.record.requirements["REQ-SEC-101"].evidence[0]);
  fs.writeFileSync(fixture.recordPath, JSON.stringify(fixture.record));
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /must cover every acceptance criterion/);
});

test("exact-RC qualification evidence rejects symlinked evidence files", () => {
  const fixture = rcEvidenceFixture();
  const source = path.join(fixture.evidenceRoot, "t2-qualification.json");
  const target = path.join(fixture.supportRoot, "outside-evidence.json");
  fs.renameSync(source, target);
  fs.symlinkSync(target, source);
  assert.match(fixture.runFixture(...fixture.enforcedArgs).stdout, /evidence path must contain only directories and a regular file/);
});
