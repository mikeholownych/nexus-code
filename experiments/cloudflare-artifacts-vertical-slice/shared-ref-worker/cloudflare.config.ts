import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "nexus-exp2b-shared-ref-20261002",
		compatibilityDate: "2026-09-30",
		entrypoint,
		env: { ARTIFACTS: bindings.artifacts({ namespace: "nexus-exp1-oct02" }) },
		observability: { enabled: false },
	},
});
