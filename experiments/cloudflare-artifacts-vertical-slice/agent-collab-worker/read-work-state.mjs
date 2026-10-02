import { readFile, stat } from "node:fs/promises";

const endpoint = "https://nexus-agent-collab-exp1-20261002.holownych.workers.dev/work-state";
const credentialPath = process.env.WORK_STATE_AUTH_FILE;
if (!credentialPath) throw new Error("WORK_STATE_AUTH_FILE is required");

const metadata = await stat(credentialPath);
if ((metadata.mode & 0o077) !== 0) throw new Error("Worker read capability file permissions must be 0600");
const capability = (await readFile(credentialPath, "utf8")).trim();
if (capability.length < 32) throw new Error("Worker read capability has invalid length");

const response = await fetch(endpoint, {
	headers: { authorization: `Bearer ${capability}` },
	cache: "no-store",
	redirect: "error",
});
if (!response.ok) throw new Error(`Worker work-state read failed with HTTP ${response.status}`);

const result = await response.json();
if (result.repository?.name !== "nexus-agent-collab-e1-b" || result.ref !== "refs/heads/work-state" || result.state?.schema !== "nexus.agent-work-state.v1") {
	throw new Error("Worker returned an unexpected work-state identity");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
