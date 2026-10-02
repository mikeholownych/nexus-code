import { env } from "cloudflare:workers";

const namespace = "nexus-exp1-oct02";
const sourceName = "external-git-proof";
const repos = new Map([
	["a", "nexus-exp2r-a"],
	["b", "nexus-exp2r-b"],
]);

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "content-type": "application/json" },
	});
}

function equalSecret(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

function authorized(request: Request): boolean {
	const secret = (env as typeof env & { EXPERIMENT_AUTH?: string }).EXPERIMENT_AUTH;
	if (!secret) return false;
	const header = request.headers.get("authorization") ?? "";
	return header.startsWith("Bearer ") && equalSecret(header.slice(7), secret);
}

async function inspect(name: string, ref: string): Promise<Response> {
	using repo = await env.ARTIFACTS.get(name);
	const info = await repo.info();
	const branchName = ref.replace(/^refs\/heads\//, "");
	const latest = await repo.log({ ref: branchName, limit: 1 });
	const head = latest[0];
	if (!head) return json({ repository: { namespace, name: info.name, id: info.id, defaultBranch: info.defaultBranch, remote: info.remote }, ref, head: null });
	const commit = await repo.readCommit(head.hash);
	if (!commit) return json({ error: "Commit read failed" }, 502);
	const tree = await repo.readTree(commit.treeHash);
	const files = [];
	for (const item of tree ?? []) {
		if (item.type !== "blob") continue;
		const blob = await repo.readBlob(item.hash);
		if (!blob) return json({ error: "Blob read failed" }, 502);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		files.push({
			path: item.name,
			blob: item.hash,
			byteLength: bytes.byteLength,
			contentSha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""),
			content: new TextDecoder().decode(bytes),
		});
	}
	return json({
		repository: { namespace, name: info.name, id: info.id, defaultBranch: info.defaultBranch, remote: info.remote },
		ref,
		head: commit.hash,
		tree: commit.treeHash,
		parents: commit.parents,
		files,
	});
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
		if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

		if (url.pathname === "/fork/a" && request.method === "POST") return fork("a");
		if (url.pathname === "/fork/b" && request.method === "POST") return fork("b");
		if (url.pathname === "/readback" && request.method === "GET") {
			const name = url.searchParams.get("repo");
			if (!name || (name !== sourceName && !Array.from(repos.values()).includes(name))) return json({ error: "Unknown repository" }, 404);
			const ref = url.searchParams.get("ref") ?? "refs/heads/main";
			if (!/^refs\/heads\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(ref)) return json({ error: "Invalid ref" }, 400);
			try {
				return await inspect(name, ref);
			} catch {
				return json({ error: "Repository inspection failed" }, 502);
			}
		}
		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler;

async function fork(key: "a" | "b"): Promise<Response> {
	const target = repos.get(key);
	if (!target) return json({ error: "Unknown fork" }, 404);
	try {
		using source = await env.ARTIFACTS.get(sourceName);
		const created = await source.fork(target, { description: `Disposable E2 recovery fork ${key.toUpperCase()}`, defaultBranchOnly: false, readOnly: false });
		// The binding returns initial credential material. Keep it in memory and never serialize or log it.
		return json({ repository: { namespace, name: created.name, id: created.id, defaultBranch: created.defaultBranch, remote: created.remote } }, 201);
	} catch {
		return json({ error: "Fork operation failed" }, 502);
	}
}
