import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "artifacts-first-repo",
		compatibilityDate: "2026-09-30",
		entrypoint,
		env: {
			ARTIFACTS: bindings.artifacts({
				namespace: "nexus-exp1-oct02",
				dev: { remote: true },
			}),
		},
		observability: { enabled: false },
	},
});
