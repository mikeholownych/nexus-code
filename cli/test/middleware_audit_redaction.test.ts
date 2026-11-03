import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { recordMiddlewareAudit } from "../src/core/persistence_protection.js";

const originalBoundary = InformationFlowBoundary.getGlobalInstance();
const temporaryHomes: string[] = [];

function setIsolatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-middleware-audit-redaction-"));
  temporaryHomes.push(home);
  process.env.HOME = home;
  return home;
}

after(() => {
  InformationFlowBoundary.setGlobalInstance(originalBoundary);
  for (const home of temporaryHomes) fs.rmSync(home, { recursive: true, force: true });
});
test("redacts synthetic credentials from middleware audit metadata before the disk append", () => {
  const previousHome = process.env.HOME;
  const home = setIsolatedHome();
  const secret = "synthetic_middleware_credential_73ac";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));

  try {
    recordMiddlewareAudit({
      kind: "middleware_rewrite",
      plugin: `plugin-${secret}`,
      tool: "write_file",
      phase: "pre",
      before_digest: "safe-before-digest",
      after_digest: "safe-after-digest",
      workspace: `/tmp/workspace-${secret}`,
    });

    const auditPath = path.join(home, ".nexus", "audit.log");
    const contents = fs.readFileSync(auditPath, "utf8");
    assert.equal(contents.includes(secret), false);
    assert.match(contents, /REDACTED/);
    assert.match(contents, /safe-before-digest/);
    assert.match(contents, /safe-after-digest/);
    assert.equal(JSON.parse(contents).kind, "middleware_rewrite");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    InformationFlowBoundary.setGlobalInstance(originalBoundary);
  }
});

test("skips middleware audit persistence when telemetry classification fails", () => {
  const previousHome = process.env.HOME;
  const home = setIsolatedHome();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);

  try {
    recordMiddlewareAudit({
      kind: "middleware_rewrite",
      plugin: "synthetic-plugin",
      tool: "write_file",
      phase: "post",
      before_digest: "safe-before",
      after_digest: "safe-after",
    });
    assert.equal(fs.existsSync(path.join(home, ".nexus", "audit.log")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    InformationFlowBoundary.setGlobalInstance(originalBoundary);
  }
});
