# RC14 lifecycle: additional cells

Two lifecycle cells run against the exact published `v1.0.0-rc.14` x86_64
artifact on Ubuntu 22.04 with Node 22. They complement the
[platform/lifecycle packet](../platform-e2/README.md) (install matrix, staging
self-test refusal, process-crash recovery, backup restore, incompatible
downgrade) and the [power-loss packet](../powerloss-node22/README.md).

Bound identities:

- RC14 archive SHA-256 `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`
- RC14 release installer SHA-256 `b243cda661eb0a57890435cfa2170fb50ea8e507aeec595d364d3f2ce71c8125`
- Installed runtime reports `1.0.0-rc.14 (16eeb6eeffe7)`, Node `v22.23.3`
- Image `nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0`

Each cell runs in a disposable `docker run --rm` container of that image; no
host HOME or credentials are mounted. Each log repeats the identities in a
`RUN_BINDING` line, so the transcript names the artifact and runtime that
produced it. The checksum cell measures the fixture archive's digest on the host
before the run and echoes that measured value.

## Checksum tamper — PASS

A tampered release index (all-zero digest for the real archive) is served on the
loopback interface. The installer refuses with
`SHA-256 verification failed; no installation was changed.` The launcher target,
a synthetic user-state marker, the installed package `MANIFEST.sha256`, and the
installed `nexus --version` are unchanged, and no staging or rollback directory
appears.
Log: [`ubuntu-22-04-node22-checksum-tamper.log`](../ubuntu-22-04-node22-checksum-tamper.log).

## Synthetic journal recovery — PASS

Journals conforming to `UpgradeJournalEntry` are written for `staged` (with a
staging directory) and `preparing` (without one), plus a malformed file:

- `staged` and `preparing`: `nexus upgrade --recover` reports `cleaned_up`,
  removes staging, keeps the launcher and the RC14 version, creates no target
  directory, and a second recovery is a no-op;
- malformed: refused with `failed schema or path validation`; the installation is
  untouched and the journal is kept for the operator.

Log: [`ubuntu-22-04-node22-synthetic-journal-recovery.log`](../ubuntu-22-04-node22-synthetic-journal-recovery.log).

This is not a power-loss test, and both cells are container runs rather than VM
runs; the [power-loss packet](../powerloss-node22/README.md) covers that
separately.

## Reproduce

```sh
./prepare-fixtures.sh <published-rc14-archive> /var/tmp/nexus-rc14-lifecycle-fixtures
./run-checksum-tamper.sh
./run-synthetic-journal-recovery.sh
```

`NEXUS_RC14_INSTALLER` and `NEXUS_RC14_FIXTURE` override the installer and
fixture paths; both scripts verify the installer digest before running. Logs are
written next to this directory.

## Scope

Two cells on one Ubuntu/Node combination. They do not complete the lifecycle
matrix across platforms and runtimes, and they are not release acceptance.
