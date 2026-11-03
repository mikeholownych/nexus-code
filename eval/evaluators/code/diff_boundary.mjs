import path from "node:path";
import { evaluatorResult } from "./result.mjs";

function normalizeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function isAllowed(file, allowed) {
  return allowed.some((entry) => {
    if (typeof entry !== "string" || !entry) return false;
    if (entry.endsWith("/")) {
      const prefix = normalizeRelative(entry.slice(0, -1));
      return prefix != null && file.startsWith(`${prefix}/`);
    }
    return normalizeRelative(entry) === file;
  });
}

/** Check git-diff-style relative paths against exact paths and directory prefixes. */
export function evaluateDiffBoundary({ changedFiles, allowedPaths }) {
  if (!Array.isArray(changedFiles) || !Array.isArray(allowedPaths)) throw new TypeError("changedFiles and allowedPaths must be arrays");
  const violations = [];
  const accepted = [];
  for (const raw of [...new Set(changedFiles)].sort()) {
    const file = normalizeRelative(raw);
    if (file == null) { violations.push({ file: raw, reason: "unsafe or non-relative path" }); continue; }
    if (!isAllowed(file, allowedPaths)) violations.push({ file, reason: "outside allowed paths" });
    else accepted.push(file);
  }
  return evaluatorResult("diff_boundary", violations.length === 0, violations.length === 0 ? 1 : 0, { accepted, violations });
}
