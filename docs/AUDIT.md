# Audit bundles: `nexus audit export` and `nexus audit verify`

An audit bundle is the evidence of one task or one session, collected into a directory with a manifest of hashes, so that someone who was not there can read what happened and can tell whether the files have changed since they were exported. Exporting uses no model and never changes the task or session it reads. Verifying checks integrity only: it does not re-run a verifier and does not judge whether the work was good.

The format and the result documents are a published contract: `docs/protocol/audit-bundle-v1.schema.json` and `docs/protocol/audit-verify-result-v1.schema.json`, generated from `cli/src/audit_contract.ts` (see `docs/protocol/README.md`).

## Exporting

```bash
nexus audit export <id> [--store tasks|sessions] [--out <dir>] [--flight <id>]... [--receipt-file <file>]... [--sign-key <private-ed25519-pem>] [--redact standard] [-w <workspace>] [--json]
```

- `<id>` is the exact id of a saved task or session. A prefix is not accepted (unlike `--resume`), and an id that is not a plain name (`A-Z a-z 0-9 . _ -`, at most 160 characters) is refused before any file is looked at. An id that exists both as a task and as a session needs `--store`.
- `--out` is the bundle directory to create. It must not exist and its parent must; the default is `./nexus-audit-<id>-<UTC time>`. The bundle is built beside its destination and renamed into place, so the destination either does not exist or is complete, and the command reports success only after that. An interrupted export can leave `<out>.partial-<random>`; it is never the bundle.
- `--flight <id>` (repeatable) names flight logs of the workspace to include; see "Flight logs" below.
- `--receipt-file <file>` (repeatable) includes a `nexus verify` result document you kept (`nexus verify --receipt`). Nexus keeps no index of those, so they are included only when named. Each is copied byte for byte as `receipts/verify-<n>.json`, in the order given. VR-3 sandbox denial events are part of that document when a refusal happened, so they reach the bundle with it; they are evidence of a refusal, never a verdict or approval.
- `--sign-key <file>` signs the manifest with an operator-provided Ed25519 private key. It is read for this invocation and never copied into the bundle. The default is unsigned.
- `-w <workspace>` names the workspace whose `.nexus/flights` is searched. The default is the workspace the record names. It changes nothing else: the bundle's subject keeps the workspace of the record.
- `--json` prints one result document instead of text.

The command prints where the bundle is, how many files it holds, each chained log and what its chain read as, everything that was left out and why, and the manifest hash. Record that hash somewhere the bundle's holder cannot change it; it is what makes an unsigned bundle checkable later.

`nexus audit export` runs as an ordinary Nexus client: it loads your configuration and waits for no other client. Nothing is sent anywhere.

## Verifying

```bash
nexus audit verify <bundle-dir> [--expect-manifest-sha256 <hex>] [--public-key <public-ed25519-pem>] [--json]
```

Verification reads the directory, not the manifest's word for it: it lists what is really there, compares that with the manifest's list, and hashes every listed file. For a signed bundle, `--public-key` checks the detached Ed25519 signature over the exact manifest bytes against the key supplied by the operator. It reports every problem it finds (the first 100 are listed, all are counted):

- a file whose bytes are not the ones the manifest records, with the expected and the found hash and size;
- a file that is listed and missing, or present and not listed;
- a symbolic link or anything that is not a regular file (it is reported and never followed or read);
- a manifest that is malformed, not in its canonical byte form, or inconsistent with its own hashes;
- a chained log (a flight log, the verification-configuration attempts) that no longer ends where the manifest recorded, or whose chain is broken;
- a chained log whose chain was already broken when the bundle was exported (`log_not_intact_at_export`), even when the bundle preserves those bytes exactly;
- a manifest whose hash is not the one given with `--expect-manifest-sha256`.

A chained log that was not closed when it was exported, an unchained legacy log, and a bounded excerpt are notes: they describe what the manifest says about the log. A log already broken at export is a failure because its source evidence is incomplete. If the log was intact at export but later changes or is cut, verification reports `log_chain_broken` or `log_head_mismatch`.

### What an intact result establishes, and what it does not

A bundle is unsigned by default. The result of verifying one says, every time:

> INTACT BY HASH ONLY: all N files match the manifest. This bundle is NOT SIGNED: anyone able to write it could have replaced its files and the manifest together.

So an intact result means the directory is consistent with its own manifest: no file was changed, removed or added, and no chained log was edited or cut, unless the manifest was rewritten to match. It does not show who wrote the bundle or that it is the one that was exported, because nothing in a bundle is secret: anyone who can write the directory can replace a file and recompute every hash.

To bind a bundle to an operator key, pass an Ed25519 private-key PEM to `export --sign-key <file>` and later pass the corresponding public-key PEM to `verify --public-key <file>`. Nexus reads the key for that command, never copies it into the bundle, and signs only the exact canonical manifest bytes with a domain separator. The public key is not embedded. A supplied but mismatched key, malformed envelope, invalid signature, or missing signature when a key is required fails verification. A signed bundle without a supplied public key is reported as `signature_unchecked` (exit 2), never as verified.

The manifest hash remains useful when signing is not used: `export` prints `manifest sha256`; keep it where the holder of the bundle cannot change it (a ticket, a signed commit, another system), and pass it to `verify --expect-manifest-sha256`. Any bundle other than the exported one then fails, however consistent it is. That protection is as strong as the place you kept the hash.

Neither the hash nor, later, a signature shows that the content was true when it was exported. A bundle holds what Nexus recorded; verification shows it has not changed since.


## Layout

```
<bundle>/
  manifest.json
  session/export.json                  the session export (nexus-session-export/2): the record, the conversation, the task state
  session/export.md                    the same for reading
  receipts/validation-receipts.json    the validation receipts of the record
  receipts/last-turn.json              the result of the last turn, with its verifier evidence
  receipts/verify-<n>.json             `nexus verify` receipts named with --receipt-file
  verification/attempts.json           the verifier attempts of the objective
  verification/config-attempts.jsonl   edits to tests, CI and build configuration and how each was decided: a hash-chained log
  evidence/provenance.json             each requirement's evidence and who produced it (a tool, or the model's claim)
  evidence/findings.json               the findings the model recorded
  evidence/diffs/<name>.diff           the complete diff of each file operation (interactive sessions)
  flights/<flight-id>.flightlog        flight logs: hash-chained
```

Files are written with mode 0600 and directories 0700.

### What the manifest hashes

- `files[]` lists every payload file, sorted by path, with its size, the SHA-256 of its bytes and its role. Each entry is linked to the one before it (the hash chain of `cli/src/core/hash_chain.ts`), and `files_head` is the last link.
- `chained_logs[]` records, for each log that is itself a hash chain, the number of records, what the chain read as at export (`intact`, `unchained` or `broken`; a log that was already damaged is recorded as such, not hidden) and the last record's link. A chain cannot show records cut from its end; the head recorded here can.
- `root_sha256` is the SHA-256 of the canonical JSON of the manifest without that member.
- `manifest.json` is exactly the canonical JSON of the manifest (keys sorted at every depth, no whitespace) and one newline. Any other byte form is refused, so the SHA-256 of the file, the "manifest hash", is well defined.
- `subject` names the task or session, the store it was read from, its status and last update, and its workspace. `workspace_sha256` is the SHA-256 of the UTF-8 bytes of the workspace path exactly as the record holds it (not resolved again, not normalised).
- `omitted[]` lists everything that was left out, each with the reason.

## What is in a bundle, and what is not

In by default: everything in the layout above that exists for the subject, except receipts of `nexus verify` (only when named) and flight logs (see below).

Not in a bundle:

| Left out | Why |
|---|---|
| `~/.nexus/audit.log` | It is global: one unchained log of every tool call in every workspace. It is not evidence of one task, and it holds other tasks' activity. |
| Other tasks' and sessions' files | Only the files stored under the subject's own id are read. |
| The tool-call evidence ledger | It exists in memory only while a turn runs. |
| The CERI evidence store | It is a library used by tests, not wired into a run. |
| Local traces (`~/.local/share/nexus/traces`) | Timings only; not exported by this version, and listed in `omitted` in every bundle. |
| The workspace itself, and Git history | A bundle is evidence of the work, not a copy of the repository. Export never runs `git`. |

## Redaction

`--redact standard` is the only redaction in this version (`strict` is refused, not ignored).

What it removes: anything Nexus's classifier takes for a credential. That is provider keys and tokens by their form (for example an API key, a GitHub token, a bearer token, a private key block, a password inside a URL), values assigned to credential-named keys, the values of credential-named environment variables of the exporting process, and strings that merely look random (long high-entropy tokens).

How it is applied depends on whether a file can be rewritten:

- **Files export generates** (`session/export.json`, `session/export.md`, the two `receipts/` files of the record, `verification/attempts.json`, the two `evidence/*.json` files) are redacted: each classified value is replaced by `[REDACTED:<kind>]`. The result is then checked again, and a file that still holds something classified as a credential is left out.
- **Files that are evidence as written** (the chained logs, the diffs, the `nexus verify` receipts) cannot be redacted without changing the bytes their hashes cover. They are scanned, and one in which a credential is found is left out whole. The stored record was already redacted when Nexus saved it, so this is rare; it happens when a credential became known to the classifier only later, or the file was put there by other means. A string that merely looks random does not cause a file to be left out.

Everything left out is in the manifest's `omitted` and in the command's output, with the reason. A bundle never claims to hold what it does not.

What standard redaction does **not** remove: prompts, model replies, tool output, source code in diffs, absolute paths, the model name and the endpoint. Anything confidential that is not a credential is still there. **A bundle is secret-redacted, not confidential**; treat it like the session it came from. A redactor is a classifier and can miss a credential of a form it does not know; read a bundle before it leaves your hands. One side effect: in the generated files a path or name that looks random can be replaced too (the workspace path is kept).

## Flight logs and the time window

A flight log (`nexus run --record-flight`) records the workspace, the model and the prompt, and no task or session id. So a bundle can only take a flight because you name it or because of when it started:

- `--flight <id>` (repeatable): exactly those logs of the workspace, recorded as `selection: "explicit"`. Naming one that does not exist is an error.
- Otherwise, every flight log of the workspace whose first record was written between the subject's creation and its last update, recorded as `selection: "time_window"`. **This is a heuristic.** Two tasks that ran in the same workspace at overlapping times cannot be told apart, so the bundle can hold another task's flight, and a flight whose task was resumed after the flight started outside the window is missed. When that matters, name the flights.

A flight log up to 16 MiB is copied whole. Of a larger one the bundle holds the longest prefix of complete records that fits (a prefix of a hash chain still verifies; a suffix would not), and the manifest records the whole log's record count, last link, size and SHA-256 under `source`, with `complete: false`. A log is never followed through a symbolic link: the workspace is writable by the agent whose work is being audited.

## The snapshot rule and `at_rest`

An export may run beside a live session. Each source file is opened once and read once; what is hashed and what is written is that one buffer, so a file of the bundle cannot disagree with its manifest entry because the source moved. The record, its message journal and its compaction archive are read under the store's lock. A log that is being appended to is cut at its last complete line; the output says so. The task or session record is loaded from a private copy that is removed afterwards, so nothing the loader would repair, migrate or re-redact is written back to your store.

`subject.at_rest` is true when the record says the work has ended (`completed`, `failed` or `interrupted`) and no operation is in flight. Otherwise the export prints a warning: the subject may have changed while it was exported and can change afterwards, and the bundle is a snapshot of that moment. A flight log without its end record is reported as not closed at export and again at every verification.

## Moving a bundle

A bundle is a directory. To move it, pack it with `tar` and verify after unpacking:

```bash
tar -C ./audit -cf task-1.tar task-1
tar -C /somewhere/else -xf task-1.tar && nexus audit verify /somewhere/else/task-1 --expect-manifest-sha256 <hash>
```

Verification does not depend on file modes, owners or times, only on names and bytes. An archive that adds files to the directory (some tools add metadata files) makes verification fail on the unexpected file, by design.

## Exit codes

Only 0 means a bundle was written or found intact. A code can stand for several conditions; the JSON document tells them apart.

| Code | Name | When |
|---|---|---|
| 0 | `exported` | `audit export`: the bundle was written. |
| 0 | `intact_signed` | `audit verify`: every file matches the manifest, and the manifest is signed by the key given with `--public-key`. |
| 0 | `intact_unsigned` | `audit verify`: every file matches the manifest and the bundle is not signed. The result rests on the manifest alone, and the output says so every time. |
| 1 | `tampered` | `audit verify`: a file is altered, missing, extra or unsafe (a symbolic link, not a regular file); the manifest is malformed or inconsistent; a chained log was already broken at export or no longer matches its recorded head; a limit was exceeded; the signature is invalid; or a key was given and the bundle has no signature. |
| 1 | `error` | The command itself failed (the bundle directory cannot be read, an export could not be written), so nothing was established. |
| 1 | `option_parse` | The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs; no JSON document). |
| 2 | `signature_unchecked` | `audit verify`: every file matches the manifest, and the bundle carries a signature that was not checked because no `--public-key` was given. |
| 2 | `unsupported_version` | `audit verify`: the bundle declares a schema version this Nexus does not read. Nothing was checked. |
| 2 | `usage` | A usage error: an invalid option value or combination, an id that is not a valid name or is in both stores without `--store`, an `--out` that already exists, an `audit verify` path that is not an existing directory, or an unknown `audit` subcommand. |
| 2 | `subject_not_found` | `audit export`: no task or session has the given id. |
| 130 | `interrupted` | Interrupted (SIGINT). |

An unknown option, a missing argument or an extra one is reported by the option parser before the command runs (`option_parse`), without a JSON document. Naming a path that is not an existing directory to `audit verify` is a usage error (exit 2), so that exit 1 always means a bundle was examined and is not intact, or the command itself failed.

## JSON output

With `--json`, stdout is exactly one document of `docs/protocol/audit-verify-result-v1.schema.json`, `schema_version` first, and its `exitCode` is the process exit code:

- `audit export`: `{ "result": "exported", "bundle_dir", "bundle_id", "manifest_sha256", "signed": false, "redaction", "at_rest", "file_count", "file_bytes", "omitted", "warnings" }`;
- `audit verify`: `{ "result": "intact_unsigned" | "tampered" | ..., "manifest_sha256", "files", "chained_logs", "findings", "findings_total", "notes", ... }`;
- either, when it could not be carried out: `{ "error", "exitCode" }`, with no `result`.
