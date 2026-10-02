import { env } from "cloudflare:workers";

const namespace = "nexus-exp1-oct02";
const repositoryName = "nexus-agent-collab-e1-b";
const stateRef = "work-state";
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

		try {
			using repo = await env.ARTIFACTS.get(repositoryName);
			const [head] = await repo.log({ ref: stateRef, limit: 1 });
			if (!head) return json({ error: "Work state not found" }, 404);
			const stateFile = await repo.readFile({ ref: stateRef, path: statePath });
			if (!stateFile) return json({ error: "Work state not found" }, 404);
			const bytes = new Uint8Array(await stateFile.arrayBuffer());
			if (bytes.byteLength > 16 * 1024) return json({ error: "Work state too large" }, 413);
			const stateText = new TextDecoder().decode(bytes);
			const state: unknown = JSON.parse(stateText);
			if (!state || typeof state !== "object" || Array.isArray(state) || (state as { schema?: unknown }).schema !== "nexus.agent-work-state.v1") {
				return json({ error: "Invalid work state" }, 502);
			}
			const candidate = (state as { candidate?: unknown }).candidate;
			let candidateHead: string | null = null;
			if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
				const candidateRef = (candidate as { ref?: unknown }).ref;
				const candidateSha = (candidate as { sha?: unknown }).sha;
				if (typeof candidateRef !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,100}$/.test(candidateRef) || typeof candidateSha !== "string" || !/^[0-9a-f]{40}$/.test(candidateSha)) {
					return json({ error: "Invalid candidate reference" }, 502);
				}
				const [candidateCommit] = await repo.log({ ref: candidateRef, limit: 1 });
				if (!candidateCommit || candidateCommit.hash !== candidateSha) return json({ error: "Candidate reference changed" }, 409);
				candidateHead = candidateCommit.hash;
			}
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			const contentSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
			const info = await repo.info();
			return json({
				repository: { namespace, name: info.name, id: info.id },
				ref: `refs/heads/${stateRef}`,
				stateCommit: head.hash,
				stateTree: head.treeHash,
				stateContentSha256: contentSha256,
				candidateHead,
				state,
			});
		} catch {
			return json({ error: "Work state unavailable" }, 502);
		}
	},
} satisfies ExportedHandler;
