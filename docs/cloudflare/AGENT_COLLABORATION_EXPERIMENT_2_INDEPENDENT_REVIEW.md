# Agent Collaboration Experiment 2 — Independent Review

**Disposition:** QUALIFIED, limited to one paired observation. No causal or general benefit is established.

**Reviewer execution:** `/root/independent_collab2_review`
**Exact reviewer model/profile:** UNKNOWN
**Date:** 2026-10-02

## Independent checks

- Fresh ordinary Git clones of the live baseline, producer, control, and treatment Artifact refs matched repository identities, branch heads, trees, and ancestry in the executor evidence.
- Baseline remained at `684db6fa5c960fdd0fe26ba213ea30a45eecd4de` / `ca25659bcb6157096cb4fbd0de17981a14e57676`.
- Producer commit `812bea492f97bd54e8a1cc9137f8beeee1b1461e` descends from baseline. Control measured ref `78a6f8c294381c7440008e6b8b0db05f63c59240` descends from baseline. Treatment final ref `7887e59d295b2405af17879d459347052a57f782` descends from treatment initial commit `ba9553df150e7370506d794dc97420976d07048a`, itself based on the same baseline.
- Fresh integrations against the same producer commit merged cleanly. The reviewer independently reproduced the control strict-TypeScript failure and summary result `undefined (undefined)`, and treatment strict-TypeScript/store/summary success (`Ada (cust-1)` and `null`).
- Live Worker deployment version `e071efb5-d1ec-464e-9c7f-86784b6c6a38` had public liveness, rejected unauthenticated protected reads, allowed authenticated read-only state retrieval, and returned 404 for authenticated mutation routes. Current work-state commit `8dd9368b4ed2f690108d0893eafd3cb1fedcd4b9` pointed to the exact producer candidate SHA.
- All four relevant Artifact token inventories showed zero active tokens after reviewer read credentials were revoked. No local, global, or system Git authorization headers were found.

## Caveats

- The control and treatment Artifact repositories were reused from Experiment 1. Their `main` refs contain prior experiment candidates; this experiment's measured refs are the separate `collab2-control` and `collab2-treatment` refs rooted at the stated baseline.
- Treatment's observed updated state included an executor-set `updatedAt` value that was not an authoritative clock reading. Treatment did not use it. A later state commit removed it after the measured outcomes; the reviewer independently observed the current state, not the historical response body at the treatment read time.
- The reviewer inspected, but did not rerun, the Gitleaks and Trivy scans. Trivy scanned an uncommitted temporary dependency resolution because the Worker package lacks a lockfile.
- Actor model/profile, exact elapsed time, and broader repeatability remain UNKNOWN. The executor saw control's failure before treatment made its correction but did not relay the result; possible experimenter influence remains a limitation.

## Falsification result

No discrepancy was found that invalidates the recorded paired integration outcome. The live Artifact refs and ordinary Git behavior support the exact observed result. This does not establish a causal effect across actors or tasks.
