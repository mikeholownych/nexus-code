// Minimum Bubblewrap for the qualification host. Releases before 0.12.0 are affected by CVE-2026-87766
// (scripts/ensure-ci-bubblewrap.sh); distro backports cannot be identified from `bwrap --version`, so a
// lower upstream version fails even when a vendor patch may exist.
export const MIN_BUBBLEWRAP = [0, 12, 0];

export function bubblewrapVersionProblem(versionOutput) {
  const match = /^bubblewrap\s+(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(versionOutput ?? "").trim());
  if (!match) return `unrecognized Bubblewrap version output: ${JSON.stringify(String(versionOutput ?? "").trim().slice(0, 80))}`;
  const version = match.slice(1, 4).map(Number);
  for (let i = 0; i < MIN_BUBBLEWRAP.length; i++) {
    if (version[i] > MIN_BUBBLEWRAP[i]) return null;
    if (version[i] < MIN_BUBBLEWRAP[i]) return `Bubblewrap ${version.join(".")} is below ${MIN_BUBBLEWRAP.join(".")} (CVE-2026-87766)`;
  }
  return null;
}
