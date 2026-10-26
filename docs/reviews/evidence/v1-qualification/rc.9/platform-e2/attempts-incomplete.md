# Incomplete exact-RC9 E2 invocations retained for classification

These harness invocation problems were observed before the passing 16-combination matrix. They are not product failures or passes:

- Initial Ubuntu 22.04 / Node 22 run installed and reported the exact RC9 version, but the host-side assertion looked for a `checks` array in `nexus doctor --json`; the actual schema uses `findings`. This run is incomplete. Its observed diagnostic was `doctor_rc=2 doctor_stderr_bytes=0`.
- A first matrix invocation requested a prepared image named `nexus-e2/ubuntu-22-04-node24`, which was not present. The final matrix uses the prepared Node 22 OS image and a read-only mount of the local Node v24.11.1 runtime. The runtime major is asserted in the runner.
- A second Node 22 invocation failed before installer execution because shell quoting changed the Node major-version assertion into invalid JavaScript `process.versions.node.split(.)`. The corrected runner uses `node --version | cut -d. -f1` and passed.

The final matrix logs are separate files and contain fresh rerun results. The failed harness excerpts above were visible in the execution output but were not captured as separate complete log files before the corrected reruns; this note preserves their classification and observed causes.
