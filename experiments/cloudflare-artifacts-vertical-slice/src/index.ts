import { env } from "cloudflare:workers";

const namespace = "nexus-exp1-oct02";
const repositoryName = "external-git-proof";
const fixturePath = "README.md";

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

async function readback(): Promise<Response> {
	using repo = await env.ARTIFACTS.get(repositoryName);
	const info = await repo.info();
	const [latest] = await repo.log({ ref: info.defaultBranch, limit: 1 });

	if (!latest) {
		return json({
			repository: { namespace, name: info.name, id: info.id, defaultBranch: info.defaultBranch, remote: info.remote },
			head: null,
		});
	}

	const commit = await repo.readCommit(latest.hash);
	if (!commit) return json({ error: "HEAD commit could not be read" }, 502);

	const tree = await repo.readTree(commit.treeHash);
	const entry = tree?.find((item) => item.name === fixturePath && item.type === "blob");
	const treeBlob = entry ? await repo.readBlob(entry.hash) : null;
	const file = await repo.readFile({ ref: info.defaultBranch, path: fixturePath });
	if (!entry || !treeBlob || !file) {
		return json({ error: "Expected fixture is missing from HEAD tree or ref" }, 502);
	}

	const treeBytes = new Uint8Array(await treeBlob.arrayBuffer());
	const fileBytes = new Uint8Array(await file.arrayBuffer());
	const digest = async (bytes: Uint8Array): Promise<string> => {
		const hash = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
	};

	return json({
		repository: { namespace, name: info.name, id: info.id, defaultBranch: info.defaultBranch, remote: info.remote },
		ref: `refs/heads/${info.defaultBranch}`,
		head: commit.hash,
		tree: commit.treeHash,
		parents: commit.parents,
		fixture: {
			path: fixturePath,
			blob: entry.hash,
			treeContentSha256: await digest(treeBytes),
			fileContentSha256: await digest(fileBytes),
			byteLength: fileBytes.byteLength,
			content: new TextDecoder().decode(fileBytes),
		},
	});
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);

		if (url.pathname === "/health" && request.method === "GET") {
			return json({ ok: true, binding: "ARTIFACTS", namespace });
		}

		if (url.pathname === "/create" && request.method === "POST") {
			try {
				const created = await env.ARTIFACTS.create(repositoryName, {
					description: "Disposable external Git interoperability proof",
					setDefaultBranch: "main",
				});
				// The create result includes an initial Git token. Never serialize or log it.
				return json({
					repository: {
						namespace,
						name: created.name,
						id: created.id,
						defaultBranch: created.defaultBranch,
						remote: created.remote,
					},
				});
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
				return json({ error: "Repository creation failed", code }, 502);
			}
		}

		if (url.pathname === "/readback" && request.method === "GET") {
			try {
				return await readback();
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
				return json({ error: "Repository readback failed", code }, 502);
			}
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler;
