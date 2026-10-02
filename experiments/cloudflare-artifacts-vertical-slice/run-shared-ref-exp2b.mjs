import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const namespace = 'nexus-exp1-oct02';
const source = { name: 'external-git-proof', id: '4v94nnw1eqf0sanw' };
const worker = 'https://nexus-exp2b-shared-ref-20261002.holownych.workers.dev';
const repoName = 'nexus-exp2b-shared-refs';
const evidencePath = path.resolve('../../docs/cloudflare/ARTIFACTS_SHARED_REF_EVIDENCE.json');
const authPath = process.env.EXPERIMENT_AUTH_FILE;
if (!authPath) throw new Error('EXPERIMENT_AUTH_FILE is required');
const authToken = (await readFile(authPath, 'utf8')).trim();
const scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-exp2b-'));
const evidence = {
  schema: 'nexus.cloudflare.artifacts.shared-ref-evidence.v1', classification: 'OBSERVED',
  execution: { startedAt: new Date().toISOString(), gitVersion: null, cfVersion: '1.0.0-beta.10', mode: 'two separate ordinary Git clones; sequential operations', scratchRetainedForIndependentReview: true },
  worker: { name: 'nexus-exp2b-shared-ref-20261002', id: '5b61e6d14d784e6d9d114950539eea98', versionId: '925889cb-a208-4a7e-8d0c-a64c5f00ecef', url: worker, auth: 'temporary secret binding, value not recorded', unauthenticatedReadStatus: null, unauthenticatedForkStatus: null },
  baseline: { namespace, ...source, expectedSha: 'ec3affd0e916b895e3528de6747b632f428359c0', expectedTree: '8a10e93afd210e09f6166ad39d144710011f16ed', readmeSha256: 'a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6' },
  repository: null, credentials: {}, refs: {}, authority: {}, comparison: {}, cleanup: { state: 'retained_for_independent_review' },
  notes: ['Token plaintext is held in process memory only; Git remotes and persistent Git config do not contain credentials.', 'All sensitive Worker routes require a bearer secret. The secret is not included in this file.'],
};
const tokenValues = new Map();
const repoInfo = { remote: null };

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  return { status: result.status ?? 127, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.code ?? null };
}
function gitEnv(token) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  return env;
}
function git(args, token = null, cwd = scratch) {
  const start = performance.now();
  const result = run('git', args, { cwd, env: gitEnv(token) });
  return { ...result, elapsedMs: Math.round((performance.now() - start) * 10) / 10 };
}
function cli(args) {
  const result = run('cf', args);
  if (result.status !== 0) throw new Error(`cf operation failed: ${args.slice(0, 4).join(' ')} (${result.status})`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`cf returned invalid JSON: ${args.slice(0, 4).join(' ')}`); }
}
async function request(route, method = 'GET', authorized = true) {
  const headers = authorized ? { authorization: `Bearer ${authToken}` } : {};
  const start = performance.now();
  const response = await fetch(`${worker}${route}`, { method, headers, cache: 'no-store', redirect: 'error' });
  const bodyText = await response.text();
  let body; try { body = JSON.parse(bodyText); } catch { body = { error: 'non_json' }; }
  return { status: response.status, elapsedMs: Math.round((performance.now() - start) * 10) / 10, body };
}
function inventory() {
  return cli(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', namespace, '--name', repoName, '--state', 'all', '--per-page', '100'])
    .map(({ id, scope, state, created_at, expires_at }) => ({ credentialId: id, scope, state, createdAt: created_at, expiresAt: expires_at }));
}
function revoke(id) { const r = run('cf', ['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', namespace, '--force']); return { credentialId: id, exitStatus: r.status, classification: r.status === 0 ? 'revoke_accepted' : 'revoke_failed' }; }
function mint(actor) {
  const value = cli(['artifacts', 'namespaces', 'tokens', 'create', namespace, '--repo', repoName, '--scope', 'write', '--ttl', '900']);
  if (!value.id || !value.plaintext || value.scope !== 'write') throw new Error(`Unexpected write credential response for actor ${actor}`);
  const expires = value.plaintext.match(/[?&]expires=(\d+)/)?.[1];
  evidence.credentials[actor] = { credentialId: value.id, repo: repoName, scope: 'write', expiresAt: expires ? new Date(Number(expires) * 1000).toISOString() : null, plaintextRecorded: false };
  tokenValues.set(actor, value.plaintext);
  return value.plaintext;
}
function safeAttempt(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return { exitStatus: result.status, elapsedMs: result.elapsedMs, result: result.status === 0 ? 'ALLOW' : /401|403|unauthori[sz]ed|forbidden|authentication failed|permission denied|write access/.test(combined) ? 'DENY' : 'OTHER_FAILURE', responseClass: result.status === 0 ? 'accepted' : /401|403|unauthori[sz]ed|forbidden|authentication failed|permission denied|write access/.test(combined) ? 'authorization_denial' : 'other', stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr) };
}
function push(token, sourceRef, targetRef, force = false, cwd = scratch) { return git(['push', ...(force ? ['--force'] : []), repoInfo.remote, `${sourceRef}:${targetRef}`], token, cwd); }
function scalar(args, token = null, cwd = scratch) { const r = git(args, token, cwd); if (r.status !== 0) throw new Error(`Git inspection failed (${r.status})`); return r.stdout.trim(); }
function writeResult() { evidence.execution.finishedAt = new Date().toISOString(); return writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }

try {
  const version = run('git', ['--version']); evidence.execution.gitVersion = version.stdout.trim();
  const unauthRead = await request(`/read?repo=${source.name}`, 'GET', false);
  const unauthFork = await request('/fork', 'POST', false);
  evidence.worker.unauthenticatedReadStatus = unauthRead.status;
  evidence.worker.unauthenticatedForkStatus = unauthFork.status;
  if (unauthRead.status !== 401 || unauthFork.status !== 401) throw new Error('Fail-closed route check failed');
  const baselineRead = await request(`/read?repo=${source.name}`);
  if (baselineRead.status !== 200 || baselineRead.body.head !== evidence.baseline.expectedSha || baselineRead.body.tree !== evidence.baseline.expectedTree) throw new Error('Baseline precondition mismatch; no fork created');
  const created = await request('/fork', 'POST');
  if (created.status !== 201 || created.body.name !== repoName || !created.body.id || !created.body.remote) throw new Error('Shared repository fork creation failed');
  repoInfo.remote = created.body.remote;
  evidence.repository = { namespace, name: created.body.name, id: created.body.id, defaultBranch: created.body.defaultBranch, remote: created.body.remote, forkElapsedMs: created.elapsedMs, source: `${namespace}/${source.name}` };
  const initialInventory = inventory();
  evidence.credentials.forkIssued = initialInventory;
  for (const credential of initialInventory.filter((item) => item.state === 'active')) {
    const outcome = revoke(credential.credentialId);
    if (outcome.exitStatus !== 0) throw new Error('Could not revoke fork-issued initial credential');
    evidence.credentials[`forkIssuedRevoke_${credential.credentialId}`] = outcome;
  }
  evidence.credentials.afterInitialRevocation = inventory();
  const tokenA = mint('tokenA'); const tokenB = mint('tokenB');
  const actorA = path.join(scratch, 'actor-a'); const actorB = path.join(scratch, 'actor-b');
  const cloneA = git(['clone', '--branch', 'main', repoInfo.remote, actorA], tokenA);
  const cloneB = git(['clone', '--branch', 'main', repoInfo.remote, actorB], tokenB);
  if (cloneA.status || cloneB.status) throw new Error('Git clone failed');
  for (const [actor, dir] of [['a', actorA], ['b', actorB]]) {
    git(['-C', dir, 'config', 'user.name', `E2B Actor ${actor.toUpperCase()}`]);
    git(['-C', dir, 'config', 'user.email', `e2b-${actor}@example.invalid`]);
    git(['-C', dir, 'checkout', '-b', `candidate-${actor}`]);
  }
  evidence.refs.initial = {};
  for (const [ref, token, dir] of [['candidate-a', tokenA, actorA], ['candidate-b', tokenB, actorB]]) {
    const start = performance.now(); const result = push(token, evidence.baseline.expectedSha, `refs/heads/${ref}`, false, dir);
    if (result.status) throw new Error(`Could not create ${ref} at baseline`);
    evidence.refs.initial[ref] = { sha: evidence.baseline.expectedSha, pushElapsedMs: Math.round((performance.now() - start) * 10) / 10 };
  }
  async function actorCommit(actor, dir, token, filename, content, stamp) {
    await writeFile(path.join(dir, filename), content);
    if (git(['-C', dir, 'add', '--', filename]).status) throw new Error('Git add failed');
    const date = { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
    const commit = run('git', ['-C', dir, 'commit', '-m', `E2B ${actor} candidate`], { env: { ...gitEnv(null), ...date } });
    if (commit.status) throw new Error('Git commit failed');
    const sha = scalar(['-C', dir, 'rev-parse', 'HEAD']); const tree = scalar(['-C', dir, 'rev-parse', 'HEAD^{tree}']); const parent = scalar(['-C', dir, 'rev-parse', 'HEAD^']);
    const contentSha256 = hash(content);
    return { sha, tree, parent, path: filename, contentSha256, commitCreatedLocally: true };
  }
  const commitA = await actorCommit('A', actorA, tokenA, 'candidate-a.txt', 'E2B candidate A\n', '2026-10-02T03:10:00Z');
  const commitB = await actorCommit('B', actorB, tokenB, 'candidate-b.txt', 'E2B candidate B\n', '2026-10-02T03:10:01Z');
  evidence.refs.candidateA = commitA; evidence.refs.candidateB = commitB;
  const pushAstart = performance.now(); evidence.authority.tokenA_candidateA = safeAttempt(push(tokenA, commitA.sha, 'refs/heads/candidate-a', false, actorA)); evidence.authority.tokenA_candidateA.elapsedMs = Math.round((performance.now() - pushAstart) * 10) / 10;
  const pushBstart = performance.now(); evidence.authority.tokenB_candidateB = safeAttempt(push(tokenB, commitB.sha, 'refs/heads/candidate-b', false, actorB)); evidence.authority.tokenB_candidateB.elapsedMs = Math.round((performance.now() - pushBstart) * 10) / 10;
  if (evidence.authority.tokenA_candidateA.result !== 'ALLOW' || evidence.authority.tokenB_candidateB.result !== 'ALLOW') throw new Error('Own candidate push failed');
  evidence.authority.tokenA_candidateB = safeAttempt(push(tokenA, commitA.sha, 'refs/heads/candidate-b', true, actorA));
  evidence.authority.tokenA_main = safeAttempt(push(tokenA, commitA.sha, 'refs/heads/main', false, actorA));
  if (evidence.authority.tokenA_main.result === 'ALLOW' && push(tokenA, evidence.baseline.expectedSha, 'refs/heads/main', true, actorA).status !== 0) throw new Error('Could not restore main after token A test');
  evidence.authority.tokenB_candidateA = safeAttempt(push(tokenB, commitB.sha, 'refs/heads/candidate-a', true, actorB));
  evidence.authority.tokenB_main = safeAttempt(push(tokenB, commitB.sha, 'refs/heads/main', false, actorB));
  if (evidence.authority.tokenB_main.result === 'ALLOW' && push(tokenB, evidence.baseline.expectedSha, 'refs/heads/main', true, actorB).status !== 0) throw new Error('Could not restore main after token B test');
  if (push(tokenA, commitA.sha, 'refs/heads/candidate-a', true, actorA).status !== 0 || push(tokenB, commitB.sha, 'refs/heads/candidate-b', true, actorB).status !== 0) throw new Error('Could not restore candidate refs after cross-authority tests');
  for (const ref of ['main', 'candidate-a', 'candidate-b']) {
    const read = await request(`/read?repo=${repoName}&ref=refs/heads/${ref}`);
    if (read.status !== 200) throw new Error(`Worker readback failed for ${ref}`);
    evidence.refs[`${ref}Readback`] = { ...read.body, elapsedMs: read.elapsedMs };
  }
  const headA = evidence.refs['candidate-aReadback'].head; const headB = evidence.refs['candidate-bReadback'].head;
  if (evidence.refs['mainReadback'].head !== evidence.baseline.expectedSha || headA !== commitA.sha || headB !== commitB.sha) throw new Error('Final ref HEAD mismatch');
  for (const [key, expected] of [['candidate-aReadback', commitA], ['candidate-bReadback', commitB]]) {
    const actual = evidence.refs[key];
    if (actual.tree !== expected.tree || actual.parents?.[0] !== evidence.baseline.expectedSha || !actual.files.some((file) => file.path === expected.path && file.contentSha256 === expected.contentSha256)) throw new Error(`Worker readback integrity mismatch: ${key}`);
  }
  for (const [actor, dir, token] of [['a', actorA, tokenA], ['b', actorB, tokenB]]) {
    if (scalar(['-C', dir, 'config', '--get', 'remote.origin.url']) !== repoInfo.remote) throw new Error('Unexpected Git remote');
    const localHeader = run('git', ['-C', dir, 'config', '--local', '--get-regexp', 'http\\..*extraheader']);
    const globalHeader = run('git', ['config', '--global', '--get-regexp', 'http\\..*extraheader']);
    evidence.refs[`actor${actor.toUpperCase()}GitConfigClean`] = localHeader.status === 1 && globalHeader.status === 1;
    const ls = git(['-C', dir, 'ls-remote', 'origin', `refs/heads/candidate-${actor}`], token, dir);
    if (ls.status) throw new Error('Fresh remote ref inspection failed');
    evidence.refs[`actor${actor.toUpperCase()}RemoteRef`] = ls.stdout.trim().split(/\s+/)[0];
  }
  const mergeBase = scalar(['-C', actorA, 'merge-base', commitA.sha, commitB.sha]);
  evidence.comparison = { mergeBase, expectedMergeBase: evidence.baseline.expectedSha, baselineToA: scalar(['-C', actorA, 'diff', '--name-status', `${evidence.baseline.expectedSha}..${commitA.sha}`]), baselineToB: scalar(['-C', actorA, 'diff', '--name-status', `${evidence.baseline.expectedSha}..${commitB.sha}`]), aToB: scalar(['-C', actorA, 'diff', '--name-status', `${commitA.sha}...${commitB.sha}`]), ordinaryGitOnly: true };
  evidence.credentials.afterTests = inventory();
  evidence.execution.actorCloneMs = { a: cloneA.elapsedMs, b: cloneB.elapsedMs };
  evidence.execution.scratchDirectory = scratch;
  await writeResult();
  console.log(JSON.stringify({ evidencePath, scratchDirectory: scratch, repository: evidence.repository, authority: evidence.authority, heads: { main: evidence.refs['mainReadback'].head, a: headA, b: headB } }, null, 2));
} catch (error) {
  evidence.execution.errorClass = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 180) : 'unknown';
  evidence.execution.scratchDirectory = scratch;
  await writeResult();
  throw error;
}
