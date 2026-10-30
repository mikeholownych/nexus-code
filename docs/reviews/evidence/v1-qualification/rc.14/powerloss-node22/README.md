# RC14 power-loss durability candidate evidence

This packet records one QEMU/KVM power-loss run of the exact published v1.0.0-rc.14 x86_64 archive. It is candidate evidence pending independent review.

The guest runs Node v22.23.3. Before the run, the harness verified the base and target archives against SHA-256 `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`. Both normalized logs repeat those exact archive digests, Node version, and Node binary digest in `POWERLOSS_RUN_BINDING` records. The write log records the cut at journal state `switched`; the verify log records recovery, rollback to RC14, state retention, staging cleanup, idempotence, and retry completion.

`runner-upstream.sh` is the harness at merge commit `8e60c347ea8bece11bbfab63dd8942f29328ec8b`. `runner-bound.sh` is the executed copy with a narrow metadata append that binds both logs to artifact and runtime identities. The kernel and Node binary hashes are in `RUN-METADATA.json`.

Scope is limited to this one Ubuntu 22.04 x86_64 power-loss scenario. It does not establish other E2 platform cells or overall release acceptance. The human terminal matrix waiver does not affect this automated test.
