// Shared `--name value` / `--name=value` parsing for the standalone CLI scripts.
// A missing value falls back rather than consuming the next flag (or process.argv[0]).
import path from "node:path";

export function optionValue(argv, name, fallback) {
  const flag = `--${name}`;
  const inline = argv.find((value) => typeof value === "string" && value.startsWith(`${flag}=`));
  if (inline !== undefined) {
    const value = inline.slice(flag.length + 1);
    return value || fallback;
  }
  const at = argv.indexOf(flag);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  return typeof value === "string" && value && !value.startsWith("--") ? value : fallback;
}

/** Resolve the lcov output against the CLI root, not the caller's cwd. */
export function resolveCoverageOut(argv, env, cli) {
  const configured = optionValue(argv, "out", env.NEXUS_COVERAGE_OUT || path.join("coverage", "lcov.info"));
  return path.resolve(cli, configured);
}
