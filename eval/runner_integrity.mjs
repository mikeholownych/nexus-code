import { assertDatasetTaskDigest } from "./dataset.mjs";
import { taskTreeDigest } from "./validate.mjs";

/** Recheck a frozen task with the digest scheme that originally pinned it. */
export function assertTaskSnapshotDigest({ dir, treeSha256, id, versionedDataset }) {
  if (versionedDataset) {
    assertDatasetTaskDigest(dir, treeSha256, id);
    return;
  }
  if (taskTreeDigest(dir) !== treeSha256) throw new Error(`frozen task ${id} changed after manifest creation`);
}
