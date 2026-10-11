import { env } from "cloudflare:workers";
import { producerCandidateRefForRun, workStateBranchForRun, workStateRefForRun } from "./work-state-contract";

const namespace = "nexus-exp1-oct02";
const repositoryName = "external-git-proof";
const statePath = ".agent/work-state.json";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request): boolean {
	const expected = (env as typeof env & { EXPERIMENT_AUTH?: string }).EXPERIMENT_AUTH;
	const header = request.headers.get("authorization") ?? "";
	if (!expected || !header.startsWith("Bearer ")) return false;
	const actual = header.slice(7);
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < actual.length; index += 1) {
		difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
	}
	return difference === 0;
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
		if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
		if (url.pathname !== "/work-state" || request.method !== "GET") return json({ error: "Not found" }, 404);
		const runValues = url.searchParams.getAll("run");
		if (runValues.length !== 1) return json({ error: "Invalid run identity" }, 400);
		const stateBranch = workStateBranchForRun(runValues[0]);
		const stateRef = workStateRefForRun(runValues[0]);
		const expectedCandidateRef = producerCandidateRefForRun(runValues[0]);
		if (!stateBranch || !stateRef || !expectedCandidateRef) return json({ error: "Invalid run identity" }, 400);

		try {
			using repo = await env.ARTIFACTS.get(repositoryName);
			const [head] = await repo.log({ ref: stateBranch, limit: 1 });
			if (!head) return json({ error: "Work state not found" }, 404);
			const stateFile = await repo.readFile({ ref: stateBranch, path: statePath });
			if (!stateFile) return json({ error: "Work state not found" }, 404);
			const bytes = new Uint8Array(await stateFile.arrayBuffer());
			if (bytes.byteLength > 16 * 1024) return json({ error: "Work state too large" }, 413);
			const stateText = new TextDecoder().decode(bytes);
			const state: unknown = JSON.parse(stateText);
			if (!state || typeof state !== "object" || Array.isArray(state) || (state as { schema?: unknown }).schema !== "nexus.agent-work-state.v1") {
				return json({ error: "Invalid work state" }, 502);
			}
			const producer = (state as { producer?: unknown }).producer;
			if (!producer || typeof producer !== "object" || Array.isArray(producer)) return json({ error: "Invalid producer state" }, 502);
			const producerState = producer as { candidateRef?: unknown; candidateCommit?: unknown };
			if (producerState.candidateRef !== expectedCandidateRef || typeof producerState.candidateCommit !== "string" || !/^[0-9a-f]{40}$/.test(producerState.candidateCommit)) {
				return json({ error: "Invalid candidate reference" }, 502);
			}
			const candidateBranch = `contest-demo/${runValues[0]}/candidate/producer`;
			const [candidateCommit] = await repo.log({ ref: candidateBranch, limit: 1 });
			if (!candidateCommit || candidateCommit.hash !== producerState.candidateCommit) return json({ error: "Candidate reference changed" }, 409);
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			const contentSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
			const info = await repo.info();
			return json({
				repository: { namespace, name: info.name, id: info.id },
				ref: stateRef,
				stateCommit: head.hash,
				stateTree: head.treeHash,
				stateContentSha256: contentSha256,
				candidateHead: candidateCommit.hash,
				state,
			});
		} catch {
			return json({ error: "Work state unavailable" }, 502);
		}
	},
} satisfies ExportedHandler;
