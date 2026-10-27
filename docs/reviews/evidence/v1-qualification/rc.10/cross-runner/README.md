# RC10 cross-runner reproducibility

Requirement `REQ-REL-114` / acceptance `ACC-SUP-08`: **PASS** for the exact published `v1.0.0-rc.10` artifact.

- Workflow: https://github.com/mikeholownych/nexus-code/actions/runs/40433818126
- Workflow source: `main` at `16ee8ca3643824741b6da67936b41f262414fdf0`
- RC tag object: `0e99eeb7268ec798d4859f01279c9db8b1ce42f6`
- RC source commit: `16ee8ca3643824741b6da67936b41f262414fdf0`
- Both Ubuntu 22.04 and Ubuntu 24.04 builders completed with pinned Node 22.22.1/npm 10.9.4 and Rust 1.95.0.
- The comparison job passed and matched both runner outputs to each other and to all six published artifacts.
- Evidence artifact SHA-256: `f393db75f06cc9675b34941c8d5e42cb7de0f01892cc2f8e64a48c9998d4fcc7`.

The retained `repro-evidence.json` records tag, tree, lockfiles, toolchain, builder images, package script identity, and the SHA-256 for `SHA256SUMS`, notices, compatibility metadata, installer, archive, and SBOM. This is one passed exact-RC reproducibility gate; it does not establish overall product acceptance or stable-release readiness.
