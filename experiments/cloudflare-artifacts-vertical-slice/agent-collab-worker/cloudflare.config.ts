import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const required = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before building or deploying the contest Worker`);
	return value;
};

export default defineConfig({
	worker: {
		name: required("NEXUS_CF_WORKER_NAME"),
		compatibilityDate: "2026-09-30",
		entrypoint,
		env: {
			ARTIFACTS: bindings.artifacts({ namespace: required("NEXUS_CF_NAMESPACE") }),
			NEXUS_NAMESPACE: bindings.text(required("NEXUS_CF_NAMESPACE")),
			NEXUS_REPOSITORY: bindings.text(required("NEXUS_CF_REPOSITORY")),
		},
		observability: { enabled: false },
	},
});
