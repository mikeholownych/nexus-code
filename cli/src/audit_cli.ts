/**
 * `nexus audit export <id>` and `nexus audit verify <bundle-dir>` (GV-2), registered under the existing `nexus audit`
 * command, which keeps printing the tool audit log when it is given no subcommand. What goes into a bundle is
 * audit_export.ts; what a bundle is and what verifying one establishes is core/audit_bundle.ts; the JSON documents and
 * the exit codes are audit_contract.ts. Every exit code here is a row of AUDIT_EXIT_CODES, except the option parser's
 * own exit (the `option_parse` row), which happens before a command runs.
 *
 * Both commands write for a person on stdout, or with `--json` exactly one document there; an error goes to stderr
 * and, with `--json`, is also the document.
 */
import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import type { Command } from "commander";
import { AUDIT_VERIFY_RESULT_SCHEMA_VERSION, auditExitCode, type AuditExitName, type AuditExportDocument, type AuditVerifyDocument, type AuditVerifyError } from "./audit_contract.js";
import { AuditExportError, exportAuditBundle, renderAuditExportText } from "./audit_export.js";
import { renderAuditVerifyText, verifyAuditBundle } from "./core/audit_bundle.js";
import { redactDiagnosticForOutput } from "./core/persistence_protection.js";
import { formatDiagnosticForOutput } from "./ui.js";

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

const printJson = (document: AuditExportDocument | AuditVerifyDocument): void => void process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

/** Ends the command without a result: the message on stderr, and with `--json` the error document on stdout. */
function fail(exit: Extract<AuditExitName, "usage" | "subject_not_found" | "error">, message: string, json: boolean): void {
  const exitCode = auditExitCode(exit);
  console.error(`error: ${formatDiagnosticForOutput(message)}`);
  if (json) printJson({ schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION, error: redactDiagnosticForOutput(message), exitCode } satisfies AuditVerifyError);
  exitAfterFlush(exitCode);
}

/** Adds `export` and `verify` to the `audit` command and makes `audit` itself refuse anything that is not one of them. */
export function registerAuditCommands(audit: Command): void {
  // `audit`'s own options (--limit, --tool, --errors) belong before a subcommand; after one, an option is the
  // subcommand's, and one it does not have is a parse error instead of being taken by `audit` and ignored.
  audit.enablePositionalOptions();

  // `nexus audit` alone prints the tool audit log, and extra arguments are accepted program-wide, so a mistyped
  // subcommand (`nexus audit verfy <dir>`) would print that log and exit 0, which reads as a verification that passed.
  audit.hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand !== audit || audit.args.length === 0) return;
    const shown = audit.args[0].replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
    console.error(`error: unknown audit subcommand '${shown}'. The subcommands are \`export\` and \`verify\`; \`nexus audit\` without one prints the tool audit log.`);
    process.exit(auditExitCode("usage"));
  });

  audit
    .command("export")
    .argument("<id>", "The exact id of a saved task or session (a prefix is not accepted)")
    .description("Write the evidence of one task or session as a secret-redacted (not confidential) audit bundle")
    .option("--store <store>", "Where the id is: tasks or sessions (needed only when it is in both)")
    .option("--out <dir>", "The bundle directory to create; it must not exist (default: ./nexus-audit-<id>-<UTC time>)")
    .option("--flight <id>", "Include this flight log of the workspace (repeatable); without it, flights are chosen by the subject's time window", collect, [])
    .option("--receipt-file <file>", "Include this `nexus verify` receipt, byte for byte (repeatable)", collect, [])
    .option("--sign-key <file>", "Sign the manifest with an operator-held Ed25519 private key (the key is never copied)")
    .option("--redact <mode>", "Redaction: standard (the only one in this version)", "standard")
    .option("-w, --workspace <path>", "The workspace whose .nexus/flights is searched (default: the one the record names)")
    .option("-j, --json", "Print the result as one JSON document on stdout")
    .allowExcessArguments(false)
    .action((id: string, options: any) => {
      const json = Boolean(options.json);
      try {
        const signingKey = options.signKey ? createPrivateKey(fs.readFileSync(path.resolve(options.signKey))) : undefined;
        if (signingKey && signingKey.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be Ed25519");
        const exported = exportAuditBundle({ id, store: options.store, out: options.out, flights: options.flight, receiptFiles: options.receiptFile, redact: options.redact, workspace: options.workspace, signingKey });
        // Reached only when the bundle is complete and renamed into place.
        if (json) printJson(exported.document);
        else process.stdout.write(renderAuditExportText(exported));
        exitAfterFlush(exported.document.exitCode);
      } catch (err) {
        if (err instanceof AuditExportError) return fail(err.exit, err.message, json);
        fail("error", `the export failed and no bundle was written (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`, json);
      }
    });

  audit
    .command("verify")
    .argument("<bundle-dir>", "The bundle directory")
    .description("Check an audit bundle against its manifest: every file's hash, the manifest's own consistency, each chained log. Integrity only; nothing is re-run")
    .option("--expect-manifest-sha256 <hex>", "The manifest hash recorded at export; any other manifest is a failure, however consistent the bundle is")
    .option("--public-key <file>", "Check a detached Ed25519 signature against this operator-held public key")
    .option("-j, --json", "Print the result as one JSON document on stdout")
    .allowExcessArguments(false)
    .action((bundleDir: string, options: any) => {
      const json = Boolean(options.json);
      const dir = path.resolve(bundleDir);
      // Naming something that is not a bundle directory is the operator's mistake, not a finding about a bundle: exit 2,
      // so that exit 1 always means a bundle was examined and is not intact, or the command itself failed.
      let stat: fs.Stats | undefined;
      let examined = true;
      try {
        stat = fs.statSync(dir, { throwIfNoEntry: false });
      } catch {
        examined = false; // It is there and cannot be examined: the library reports that as an error.
      }
      if (examined && !stat) return fail("usage", "there is no bundle directory at that path; nothing was checked", json);
      if (stat && !stat.isDirectory()) return fail("usage", "an audit bundle is a directory; that path is not one. Nothing was checked", json);
      let publicKey;
      try {
        publicKey = options.publicKey ? createPublicKey(fs.readFileSync(path.resolve(options.publicKey))) : undefined;
      } catch {
        return fail("usage", "the public key could not be read", json);
      }
      if (publicKey && publicKey.asymmetricKeyType !== "ed25519") return fail("usage", "the public key must be Ed25519", json);
      const { document } = verifyAuditBundle(dir, { ...(options.expectManifestSha256 === undefined ? {} : { expectManifestSha256: String(options.expectManifestSha256) }), ...(publicKey ? { publicKey } : {}) });
      if (json) printJson(document);
      else process.stdout.write(renderAuditVerifyText(document));
      exitAfterFlush(document.exitCode);
    });
}
