import { env } from "cloudflare:workers";

const namespace = "nexus-exp1-oct02";
const sourceName = "external-git-proof";
const sharedName = "nexus-exp2b-shared-refs";

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request): boolean {
	const expected = (env as typeof env & { EXPERIMENT_AUTH?: string }).EXPERIMENT_AUTH;
	const supplied = request.headers.get("authorization") ?? "";
	if (!expected || !supplied.startsWith("Bearer ")) return false;
	const actual = supplied.slice(7);
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
	return difference === 0;
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
		if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
		if (url.pathname === "/fork" && request.method === "POST") {
			try {
				using source = await env.ARTIFACTS.get(sourceName);
				const forked = await source.fork(sharedName, { defaultBranchOnly: false, readOnly: false });
				return json({ name: forked.name, id: forked.id, defaultBranch: forked.defaultBranch, remote: forked.remote }, 201);
			} catch {
				return json({ error: "Fork failed" }, 502);
			}
		}
		if (url.pathname === "/read" && request.method === "GET") {
			const repoName = url.searchParams.get("repo");
			const ref = url.searchParams.get("ref") ?? "refs/heads/main";
			if (repoName !== sourceName && repoName !== sharedName) return json({ error: "Unknown repository" }, 404);
			if (!/^refs\/heads\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(ref)) return json({ error: "Invalid ref" }, 400);
			try {
				using repo = await env.ARTIFACTS.get(repoName);
				const info = await repo.info();
				const [head] = await repo.log({ ref: ref.slice("refs/heads/".length), limit: 1 });
				if (!head) return json({ repositoryId: info.id, ref, head: null });
				const commit = await repo.readCommit(head.hash);
				if (!commit) return json({ error: "Commit unavailable" }, 502);
				const tree = await repo.readTree(commit.treeHash);
				const files = [];
				for (const item of tree ?? []) {
					if (item.type !== "blob") continue;
					const blob = await repo.readBlob(item.hash);
					if (!blob) return json({ error: "Blob unavailable" }, 502);
					const bytes = new Uint8Array(await blob.arrayBuffer());
					const digest = await crypto.subtle.digest("SHA-256", bytes);
					files.push({ path: item.name, blob: item.hash, contentSha256: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join(""), byteLength: bytes.length });
				}
				return json({ repositoryId: info.id, repositoryName: info.name, defaultBranch: info.defaultBranch, ref, head: commit.hash, tree: commit.treeHash, parents: commit.parents, files });
			} catch {
				return json({ error: "Repository read failed" }, 502);
			}
		}
		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler;
