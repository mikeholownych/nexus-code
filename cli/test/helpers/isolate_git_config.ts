import type { TestContext } from "node:test";

/** Limit fixture checks to repository-local Git configuration. */
export function isolateGitConfig(t: Pick<TestContext, "after">): void {
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
