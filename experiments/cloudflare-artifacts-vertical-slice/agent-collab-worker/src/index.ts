import { env } from "cloudflare:workers";

const namespace = "nexus-exp1-oct02";
const sourceName = "external-git-proof";
const repos = {
	baseline: "nexus-agent-collab-e1-base",
	b: "nexus-agent-collab-e1-b",
	control: "nexus-agent-collab-e1-control",
	treatment: "nexus-agent-collab-e1-treatment",
} as const;
type RepoKey = keyof typeof repos;

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
	for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
	return difference === 0;
}

function isRepoKey(value: string | null): value is RepoKey {
	return value !== null && Object.hasOwn(repos, value);
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
		if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
		if (url.pathname === "/baseline" && request.method === "POST") {
			try {
				using source = await env.ARTIFACTS.get(sourceName);
				const fork = await source.fork(repos.baseline, { defaultBranchOnly: false, readOnly: false });
				return json({ name: fork.name, id: fork.id, defaultBranch: fork.defaultBranch, remote: fork.remote }, 201);
			} catch {
				return json({ error: "Baseline fork failed" }, 502);
			}
		}
		const forkMatch = url.pathname.match(/^\/fork\/(b|control|treatment)$/);
		if (forkMatch && request.method === "POST") {
			const key = forkMatch[1] as Exclude<RepoKey, "baseline">;
			try {
				using source = await env.ARTIFACTS.get(repos.baseline);
				const fork = await source.fork(repos[key], { defaultBranchOnly: false, readOnly: false });
				return json({ name: fork.name, id: fork.id, defaultBranch: fork.defaultBranch, remote: fork.remote }, 201);
			} catch {
				return json({ error: "Fork failed" }, 502);
			}
		}
		if (url.pathname === "/read" && request.method === "GET") {
			const key = url.searchParams.get("repo");
			const ref = url.searchParams.get("ref") ?? "refs/heads/main";
			if (!isRepoKey(key)) return json({ error: "Unknown repository" }, 404);
			if (!/^refs\/heads\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(ref)) return json({ error: "Invalid ref" }, 400);
			try {
				using repo = await env.ARTIFACTS.get(repos[key]);
				const info = await repo.info();
				const [head] = await repo.log({ ref: ref.slice("refs/heads/".length), limit: 1 });
				if (!head) return json({ repository: { namespace, name: info.name, id: info.id }, ref, head: null });
				const commit = await repo.readCommit(head.hash);
				if (!commit) return json({ error: "Commit unavailable" }, 502);
				const files: Array<{ path: string; blob: string; contentSha256: string; byteLength: number }> = [];
				await visitTree(repo, commit.treeHash, "", files);
				return json({ repository: { namespace, name: info.name, id: info.id, defaultBranch: info.defaultBranch }, ref, head: commit.hash, tree: commit.treeHash, parents: commit.parents, files });
			} catch {
				return json({ error: "Repository read failed" }, 502);
			}
		}
		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler;

async function visitTree(repo: ArtifactsRepo, treeHash: string, prefix: string, files: Array<{ path: string; blob: string; contentSha256: string; byteLength: number }>): Promise<void> {
	for (const item of await repo.readTree(treeHash) ?? []) {
		const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.type === "tree") await visitTree(repo, item.hash, itemPath, files);
		else if (item.type === "blob") {
			const blob = await repo.readBlob(item.hash);
			if (!blob) throw new Error("Blob unavailable");
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			files.push({ path: itemPath, blob: item.hash, contentSha256: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join(""), byteLength: bytes.byteLength });
		}
	}
}
