import { withBrokerSession } from "./credential-broker.mjs";

const remoteUrl = "https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git";
const out = await withBrokerSession({
	namespace: "nexus-exp1-oct02",
	repo: "external-git-proof",
	scope: "read",
	ttlSeconds: 900
}, async (s) => {
	const res = s.runGit(["ls-remote", remoteUrl, "refs/heads/contest-slice"]);
	return res.stdout.trim();
});

console.log("VERIFIED_REMOTE_REF:", out.result);
