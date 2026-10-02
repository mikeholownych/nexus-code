import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const namespace = 'nexus-exp1-oct02';
const source = { name: 'external-git-proof', id: '4v94nnw1eqf0sanw' };
const expectedBaseline = {
  sha: 'ec3affd0e916b895e3528de6747b632f428359c0',
  tree: '8a10e93afd210e09f6166ad39d144710011f16ed',
  readmeSha256: 'a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6',
};
const forks = {
  a: { name: 'nexus-exp2r-a', probe: 'refs/heads/e2r-token-a-probe' },
  b: { name: 'nexus-exp2r-b', probe: 'refs/heads/e2r-token-b-probe' },
};
const baselineProbe = { a: 'refs/heads/e2r-token-a-baseline', b: 'refs/heads/e2r-token-b-baseline' };
const worker = 'https://nexus-exp2-recovery-20261002.holownych.workers.dev';
const recordPath = path.resolve('../../docs/cloudflare/ARTIFACTS_FORK_ISOLATION_RECOVERY_EVIDENCE.json');
const startedAt = new Date().toISOString();
const scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-e2-recovery-'));
const authPath = process.env.EXPERIMENT_AUTH_FILE;
if (!authPath) throw new Error('EXPERIMENT_AUTH_FILE is required');
const authToken = (await readFile(authPath, 'utf8')).trim();
if (authToken.length < 32) throw new Error('Worker auth secret is unexpectedly short');
const runnerSource = await readFile(new URL(import.meta.url));
const workerSource = await readFile(new URL('./fork-worker/src/index.ts', import.meta.url));

const record = {
  schema: 'nexus.cloudflare.artifacts.fork-isolation-evidence.v1',
  classification: 'OBSERVED',
  execution: {
	startedAt,
	finishedAt: null,
	gitVersion: null,
	cfVersion: '1.0.0-beta.10',
	runnerSha256: hash(runnerSource),
	workerSourceSha256: hash(workerSource),
	gitChildEnvironment: {
		policy: 'allowlisted variables; repository authorization supplied only via ephemeral GIT_CONFIG_VALUE_0',
		secretLikeParentVariablesSuppressed: Object.keys(process.env).filter((key) => /(TOKEN|SECRET|PASSWORD|API_KEY|AUTH)/i.test(key)).length,
		terminalPromptDisabled: true,
	},
	},
  baseline: { namespace, ...source, expected: expectedBaseline, before: null, after: null },
  worker: {
	name: 'nexus-exp2-recovery-20261002',
	url: worker,
	id: process.env.EXPERIMENT_WORKER_ID ?? null,
	versionId: process.env.EXPERIMENT_WORKER_VERSION_ID ?? null,
	deployedAt: process.env.EXPERIMENT_WORKER_DEPLOYED_AT ?? null,
	auth: 'secret binding; value not recorded',
	unauthenticatedReadback: null,
	unauthenticatedForkPost: null,
  },
  forks: {},
  actors: {},
  authority: {},
  integrity: {},
  credentialMetadata: [],
  credentialInventory: { baselineBefore: null, forkInitial: {}, afterActorCredentials: {} },
  notes: [
    'No token plaintext, authorization header, or authenticated remote URL is written to this file.',
    'A first harness run found that the Workers binding log() expects a branch name such as main, not the full refs/heads/main name. This was corrected before any fork or repository token was created.',
  ],
};
const credentials = new Map();

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  return { status: result.status ?? 127, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.code ?? null };
}

function minimalGitEnv() {
	const env = {};
	for (const key of [
		'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR',
		'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
	]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	env.GIT_TERMINAL_PROMPT = '0';
	return env;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeTiming(ms) {
  return Math.round(ms * 10) / 10;
}

function cli(args) {
  const result = run('cf', args);
  if (result.status !== 0) throw new Error(`cf operation failed: ${args.slice(0, 4).join(' ')} (${result.status})`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`cf operation returned non-JSON: ${args.slice(0, 4).join(' ')}`); }
}

function authEnv(token) {
	const env = { ...minimalGitEnv(), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
	return env;
}

function git(args, token = null, cwd = scratch) {
	const before = performance.now();
	const result = run('git', args, { cwd, env: token ? authEnv(token) : minimalGitEnv() });
	return { ...result, elapsedMs: safeTiming(performance.now() - before) };
}

function gitPersistentConfig(args, cwd) {
	return run('git', args, { cwd, env: minimalGitEnv() });
}

function sanitizePush(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const authDenied = /401|403|unauthori[sz]ed|forbidden|authentication failed|write access|permission denied|not allowed/.test(combined);
  const remoteError = combined.match(/(?:http|status)[^\n]*(?:401|403)/)?.[0] ?? null;
  return {
    exitStatus: result.status,
    elapsedMs: result.elapsedMs,
    classification: result.status === 0 ? 'push_accepted' : authDenied ? 'authorization_denied' : 'push_failed_other',
    denialHint: remoteError ? 'HTTP 401/403 response observed' : null,
    stdoutSha256: hash(Buffer.from(result.stdout)),
    stderrSha256: hash(Buffer.from(result.stderr)),
  };
}

async function workerRequest(pathname, { method = 'GET', authorized = true } = {}) {
  const headers = authorized ? { authorization: `Bearer ${authToken}` } : {};
  const before = performance.now();
  const response = await fetch(`${worker}${pathname}`, { method, headers, cache: 'no-store', redirect: 'error' });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: 'non_json_response' }; }
  return { status: response.status, elapsedMs: safeTiming(performance.now() - before), body };
}

function token(scope, repo) {
  const response = cli(['artifacts', 'namespaces', 'tokens', 'create', namespace, '--repo', repo, '--scope', scope, '--ttl', '900']);
  if (!response.id || !response.plaintext || response.scope !== scope) throw new Error(`Unexpected ${scope} token response for ${repo}`);
  const expiry = response.plaintext.match(/[?&]expires=(\d+)/)?.[1];
  const item = { id: response.id, repository: repo, scope, expiresAt: expiry ? new Date(Number(expiry) * 1000).toISOString() : null };
  record.credentialMetadata.push(item);
  credentials.set(`${repo}:${scope}`, { ...item, plaintext: response.plaintext });
  return credentials.get(`${repo}:${scope}`);
}

function tokenInventory(repo) {
	const response = cli(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', namespace, '--name', repo, '--state', 'all', '--per-page', '100']);
	if (!Array.isArray(response)) throw new Error(`Unexpected token list response for ${repo}`);
	return response.map(({ id, scope, state, created_at, expires_at }) => ({ id, scope, state, createdAt: created_at, expiresAt: expires_at }));
}

function revokeToken(id) {
	const result = run('cf', ['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', namespace, '--force']);
	return { id, exitStatus: result.status, classification: result.status === 0 ? 'revoke_accepted' : 'revoke_failed' };
}

function createActor(key, startSha) {
  const repo = forks[key];
  const cloneDir = path.join(scratch, `actor-${key}`);
  const tokenRecord = credentials.get(`${repo.name}:write`);
  const clone = git(['clone', '--branch', 'main', repo.remote, cloneDir], tokenRecord.plaintext);
  if (clone.status !== 0) throw new Error(`Git clone failed for actor ${key} (${clone.status})`);
  const head = git(['-C', cloneDir, 'rev-parse', 'HEAD'], tokenRecord.plaintext);
  const tree = git(['-C', cloneDir, 'rev-parse', 'HEAD^{tree}'], tokenRecord.plaintext);
  if (head.stdout.trim() !== startSha) throw new Error(`Actor ${key} started from unexpected SHA`);
  git(['-C', cloneDir, 'config', 'user.name', `E2 Recovery Actor ${key.toUpperCase()}`], tokenRecord.plaintext);
  git(['-C', cloneDir, 'config', 'user.email', `e2-${key}@example.invalid`], tokenRecord.plaintext);
  const fixturePath = `actor-${key}-recovery-rerun.txt`;
  const content = Buffer.from(`Nexus Cloudflare Artifacts E2 recovery rerun actor ${key.toUpperCase()}\nBaseline ${startSha}\n`);
  return { cloneDir, cloneMs: clone.elapsedMs, initialSha: head.stdout.trim(), initialTree: tree.stdout.trim(), fixturePath, content, token: tokenRecord };
}

function commitActor(key, actor) {
  const file = path.join(actor.cloneDir, actor.fixturePath);
  return writeFile(file, actor.content).then(() => {
    const stage = git(['-C', actor.cloneDir, 'add', '--', actor.fixturePath], actor.token.plaintext);
    const commit = git(['-C', actor.cloneDir, 'commit', '-m', `E2 recovery actor ${key.toUpperCase()} fixture`], actor.token.plaintext);
    if (stage.status !== 0 || commit.status !== 0) throw new Error(`Local commit failed for actor ${key}`);
    const sha = git(['-C', actor.cloneDir, 'rev-parse', 'HEAD'], actor.token.plaintext).stdout.trim();
    const tree = git(['-C', actor.cloneDir, 'rev-parse', 'HEAD^{tree}'], actor.token.plaintext).stdout.trim();
    const parents = git(['-C', actor.cloneDir, 'rev-list', '--parents', '-n', '1', 'HEAD'], actor.token.plaintext).stdout.trim().split(/\s+/).slice(1);
    const contentSha256 = hash(actor.content);
    record.actors[key] = {
      execution: 'ordinary external Git client',
      worktree: 'temporary; removed after evidence capture',
      cloneExitStatus: 0,
      cloneElapsedMs: actor.cloneMs,
      initialSha: actor.initialSha,
      initialTree: actor.initialTree,
      parentShas: parents,
      commitSha: sha,
      treeSha: tree,
      fixturePath: actor.fixturePath,
      fixtureContentSha256: contentSha256,
      fixtureByteLength: actor.content.byteLength,
      localIdentity: `E2 Recovery Actor ${key.toUpperCase()}`,
      tokenId: actor.token.id,
    };
    return { ...actor, sha, tree, parents, contentSha256 };
  });
}

async function attemptPush(label, fromActor, targetRepo, targetRef, credential) {
  const started = performance.now();
  const result = git(['-C', fromActor.cloneDir, 'push', '--porcelain', targetRepo.remote, `${fromActor.sha}:${targetRef}`], credential.plaintext);
  const push = sanitizePush({ ...result, elapsedMs: safeTiming(performance.now() - started) });
  const readback = await workerRequest(`/readback?repo=${encodeURIComponent(targetRepo.name)}&ref=${encodeURIComponent(targetRef)}`);
  const observedSha = readback.body.head ?? null;
  const absent = readback.status === 200 && observedSha === null;
  const allowed = result.status === 0 && observedSha === fromActor.sha;
  const denied = result.status !== 0 && push.classification === 'authorization_denied' && absent;
  record.authority[label] = {
    credential: { id: credential.id, scope: credential.scope, repository: credential.repository },
    targetRepository: targetRepo.name,
    targetRef,
    attempt: push,
    workerReadback: { status: readback.status, elapsedMs: readback.elapsedMs, observedSha },
    result: allowed ? 'ALLOW' : denied ? 'DENY' : 'INCONCLUSIVE',
  };
  return record.authority[label];
}

async function persist() {
  record.execution.finishedAt = new Date().toISOString();
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

try {
  const gitVersion = git(['--version'], null);
  record.execution.gitVersion = gitVersion.stdout.trim();
  if (gitVersion.status !== 0) throw new Error('Git client unavailable');

  const before = await workerRequest('/readback?repo=external-git-proof');
  record.baseline.before = { status: before.status, sha: before.body.head, tree: before.body.tree, parents: before.body.parents, repository: before.body.repository };
  if (before.status !== 200 || before.body.head !== expectedBaseline.sha || before.body.tree !== expectedBaseline.tree) throw new Error('Baseline does not match the accepted E1 identity');
  const readme = before.body.files?.find((file) => file.path === 'README.md');
  if (!readme || readme.contentSha256 !== expectedBaseline.readmeSha256) throw new Error('Baseline README digest mismatch');
  record.baseline.before.readmeSha256 = readme.contentSha256;

  const unauthReadback = await workerRequest('/readback?repo=external-git-proof', { authorized: false });
  const unauthFork = await workerRequest('/fork/a', { method: 'POST', authorized: false });
  record.worker.unauthenticatedReadback = { status: unauthReadback.status, classification: unauthReadback.status === 401 ? 'rejected_unauthorized' : 'unexpected_response' };
  record.worker.unauthenticatedForkPost = { status: unauthFork.status, classification: unauthFork.status === 401 ? 'rejected_unauthorized' : 'unexpected_response' };
  if (unauthReadback.status !== 401 || unauthFork.status !== 401) throw new Error('Unauthenticated Worker request was not rejected');
  const baselineTokensBefore = tokenInventory(source.name);
	record.credentialInventory.baselineBefore = baselineTokensBefore;
	if (baselineTokensBefore.some((item) => item.state === 'active')) throw new Error('Unexpected active credential exists on baseline before experiment');

  for (const key of ['a', 'b']) {
    const result = await workerRequest(`/fork/${key}`, { method: 'POST' });
    if (result.status !== 201 || result.body.repository?.name !== forks[key].name) throw new Error(`Fork ${key} creation failed (${result.status})`);
    forks[key] = { ...forks[key], ...result.body.repository, createdElapsedMs: result.elapsedMs };
    record.forks[key] = {
      namespace: forks[key].namespace,
      name: forks[key].name,
      id: forks[key].id,
      defaultBranch: forks[key].defaultBranch,
      remote: forks[key].remote,
      createdElapsedMs: result.elapsedMs,
      sourceRepository: `${namespace}/${source.name}`,
    };
  }
	for (const key of ['a', 'b']) {
		const initialInventory = tokenInventory(forks[key].name);
		record.credentialInventory.forkInitial[key] = initialInventory;
		record.credentialInventory.forkInitialRevocation ??= {};
		record.credentialInventory.forkInitialRevocation[key] = initialInventory.filter((item) => item.state === 'active').map((item) => revokeToken(item.id));
		record.credentialInventory.forkAfterInitialRevocation ??= {};
		const afterInitialRevocation = tokenInventory(forks[key].name);
		record.credentialInventory.forkAfterInitialRevocation[key] = afterInitialRevocation;
		if (afterInitialRevocation.some((item) => item.state === 'active')) throw new Error(`Fork ${key} initial credential revocation did not complete`);
	}

  const writeA = token('write', forks.a.name);
  const writeB = token('write', forks.b.name);
  const baselineRead = token('read', source.name);
	record.credentialInventory.afterActorCredentials = {
		forkA: tokenInventory(forks.a.name),
		forkB: tokenInventory(forks.b.name),
		baseline: tokenInventory(source.name),
	};
  const actorA = createActor('a', expectedBaseline.sha);
  const actorB = createActor('b', expectedBaseline.sha);
  const commitA = await commitActor('a', actorA);
  const commitB = await commitActor('b', actorB);

  const ownA = await attemptPush('tokenA_to_forkA', commitA, forks.a, 'refs/heads/main', writeA);
  const ownB = await attemptPush('tokenB_to_forkB', commitB, forks.b, 'refs/heads/main', writeB);
  const crossAB = await attemptPush('tokenA_to_forkB', commitA, forks.b, forks.b.probe, writeA);
  const crossBA = await attemptPush('tokenB_to_forkA', commitB, forks.a, forks.a.probe, writeB);
  const baselineA = await attemptPush('tokenA_to_baseline', commitA, { ...source, remote: before.body.repository.remote }, baselineProbe.a, writeA);
  const baselineB = await attemptPush('tokenB_to_baseline', commitB, { ...source, remote: before.body.repository.remote }, baselineProbe.b, writeB);

  const observations = {};
  for (const [key, repo] of Object.entries({ baseline: source, forkA: forks.a, forkB: forks.b })) {
    const targetName = repo.name;
    const main = await workerRequest(`/readback?repo=${encodeURIComponent(targetName)}&ref=refs%2Fheads%2Fmain`);
    observations[key] = { status: main.status, elapsedMs: main.elapsedMs, repositoryId: main.body.repository?.id, ref: main.body.ref, head: main.body.head, tree: main.body.tree, parents: main.body.parents, files: (main.body.files ?? []).map(({ path: filePath, contentSha256, byteLength, blob }) => ({ path: filePath, contentSha256, byteLength, blob })) };
  }

  const freshClones = {};
  for (const [key, repo, cred] of [['forkA', forks.a, writeA], ['forkB', forks.b, writeB], ['baseline', { ...source, remote: before.body.repository.remote }, baselineRead]]) {
    const dir = path.join(scratch, `verify-${key}`);
    const clone = git(['clone', '--branch', 'main', repo.remote, dir], cred.plaintext);
    const head = clone.status === 0 ? git(['-C', dir, 'rev-parse', 'HEAD'], cred.plaintext).stdout.trim() : null;
    const tree = clone.status === 0 ? git(['-C', dir, 'rev-parse', 'HEAD^{tree}'], cred.plaintext).stdout.trim() : null;
    const localConfig = clone.status === 0 ? gitPersistentConfig(['-C', dir, 'config', '--local', '--get-regexp', '^http\\..*extraheader$'], dir) : null;
    const globalConfig = clone.status === 0 ? gitPersistentConfig(['config', '--global', '--get-regexp', '^http\\..*extraheader$'], dir) : null;
    const systemConfig = clone.status === 0 ? gitPersistentConfig(['config', '--system', '--get-regexp', '^http\\..*extraheader$'], dir) : null;
    const remoteUrl = clone.status === 0 ? gitPersistentConfig(['-C', dir, 'remote', 'get-url', 'origin'], dir).stdout.trim() : '';
    freshClones[key] = { exitStatus: clone.status, elapsedMs: clone.elapsedMs, head, tree, remoteHasNoCredentials: !/@|:\/\/[^/]*:[^/@]+@/.test(remoteUrl), localAuthConfigAbsent: localConfig?.status === 1, globalAuthConfigAbsent: globalConfig?.status === 1, systemAuthConfigAbsent: systemConfig?.status === 1 };
  }

  record.integrity = {
    authoritativeReadbacks: observations,
    freshGitClones: freshClones,
    baselineMainUnchanged: observations.baseline.head === expectedBaseline.sha && observations.baseline.tree === expectedBaseline.tree,
		commitAndContentMatches: {
			forkA: observations.forkA.head === commitA.sha && observations.forkA.tree === commitA.tree && observations.forkA.parents?.[0] === expectedBaseline.sha && observations.forkA.files.some((file) => file.path === commitA.fixturePath && file.contentSha256 === commitA.contentSha256),
			forkB: observations.forkB.head === commitB.sha && observations.forkB.tree === commitB.tree && observations.forkB.parents?.[0] === expectedBaseline.sha && observations.forkB.files.some((file) => file.path === commitB.fixturePath && file.contentSha256 === commitB.contentSha256),
		},
    tokenAWriteOwn: ownA.result,
    tokenBWriteOwn: ownB.result,
    tokenACrossForkDenied: crossAB.result,
    tokenBCrossForkDenied: crossBA.result,
    tokenABaselineDenied: baselineA.result,
    tokenBBaselineDenied: baselineB.result,
  };
	record.baseline.after = record.integrity.authoritativeReadbacks.baseline;

  await persist();
} catch (error) {
  record.execution.failure = error instanceof Error ? error.message : 'unknown failure';
  await persist();
  process.exitCode = 1;
} finally {
  // Credentials remain valid for independent review. The operator-authorized cleanup follows review.
  const tokenFingerprints = [];
  for (const item of credentials.values()) {
    const fingerprint = createHash('sha256').update(item.plaintext).digest('hex').slice(0, 12);
    tokenFingerprints.push(fingerprint);
    const secret = Buffer.from(item.plaintext);
    secret.fill(0);
  }
  for (const item of credentials.values()) item.plaintext = '';
  record.execution.credentialFingerprintsNotRetained = tokenFingerprints.length;
  await rm(scratch, { recursive: true, force: true });
  await persist();
  process.stdout.write(`${JSON.stringify({ evidence: recordPath, failure: record.execution.failure ?? null, authority: record.authority, integrity: record.integrity ?? null, retainedCredentialCount: credentials.size }, null, 2)}\n`);
}
