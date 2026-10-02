import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const namespace = 'nexus-exp1-oct02';
const repo = 'external-git-proof';
const remote = 'https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git';
const worker = 'https://artifacts-first-repo.holownych.workers.dev';
const fixturePath = 'README.md';
const fixture = Buffer.from('# Cloudflare Artifacts Experiment\n\nCreated by an external Git client.\n');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'cf-artifacts-exp1-'));
const issued = [];

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, ...options });
  if (result.error) throw new Error(`${bin} execution failed`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function cli(args) {
  const r = run('cf', args);
  if (r.status !== 0) throw new Error(`cf command failed (${args.slice(0, 4).join(' ')})`);
  return JSON.parse(r.stdout);
}
function token(scope) {
  const result = run('cf', ['artifacts', 'namespaces', 'tokens', 'create', namespace, '--repo', repo, '--scope', scope, '--ttl', '3600']);
  if (result.status !== 0) throw new Error(`token create failed (${scope})`);
  const data = JSON.parse(result.stdout);
  if (!data.id || !data.plaintext || data.scope !== scope) throw new Error(`unexpected ${scope} token response`);
  const expiryMatch = data.plaintext.match(/[?&]expires=(\d+)/);
  const expiresAt = expiryMatch ? new Date(Number(expiryMatch[1]) * 1000).toISOString() : null;
  issued.push({ id: data.id, scope, expiresAt });
  return { id: data.id, scope, expiresAt, plaintext: data.plaintext };
}
function git(dir, args, secret, expected = 0) {
  const started = performance.now();
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` };
  delete env.GIT_TRACE; delete env.GIT_CURL_VERBOSE; delete env.GIT_TRACE_CURL;
  const r = run('git', args, { cwd: dir, env });
  const elapsedMs = Math.round(performance.now() - started);
  if (expected === 0 && r.status !== 0) throw new Error(`git operation failed (${args[0]})`);
  return { ...r, elapsedMs };
}
async function getReadback() {
  const response = await fetch(`${worker}/readback`, { cache: 'no-store' });
  const body = await response.json();
  return { status: response.status, body };
}
async function revoke(id) {
  const r = run('cf', ['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', namespace, '--force']);
  return { id, revoked: r.status === 0 };
}

let output;
try {
  const version = run('git', ['--version']);
  const initial = await getReadback();
  if (initial.status !== 200 || initial.body.head !== null) throw new Error('repository was not in expected empty state');
  const readToken = token('read');
  const writeToken = token('write');
  const clone = path.join(scratch, 'external-clone');
  const cloneResult = git(scratch, ['clone', '--no-checkout', remote, clone], readToken.plaintext);
  // The first clone is an ordinary authenticated Git clone. Set identity only in the disposable worktree.
  const initialBranch = initial.body.repository.defaultBranch;
  const initialHeadResult = git(scratch, ['-C', clone, 'rev-parse', '--verify', 'HEAD'], readToken.plaintext, 1);
  const initialHead = initialHeadResult.status === 0 ? initialHeadResult.stdout.trim() : null;
  if (initialHead) git(scratch, ['-C', clone, 'checkout', initialBranch], readToken.plaintext);
  git(scratch, ['-C', clone, 'config', 'user.name', 'Artifacts Experiment'], readToken.plaintext);
  git(scratch, ['-C', clone, 'config', 'user.email', 'artifacts-experiment@example.invalid'], readToken.plaintext);
  await writeFile(path.join(clone, fixturePath), fixture);
  git(scratch, ['-C', clone, 'add', fixturePath], readToken.plaintext);
  git(scratch, ['-C', clone, 'commit', '-m', 'Initial external Git commit'], readToken.plaintext);
  const commit = git(scratch, ['-C', clone, 'rev-parse', 'HEAD'], readToken.plaintext).stdout.trim();
  const tree = git(scratch, ['-C', clone, 'rev-parse', 'HEAD^{tree}'], readToken.plaintext).stdout.trim();
  const parentOutput = git(scratch, ['-C', clone, 'rev-list', '--parents', '-n', '1', 'HEAD'], readToken.plaintext).stdout.trim().split(/\s+/);
  const parent = parentOutput[1] ?? null;
  const readPushStarted = performance.now();
  const denied = git(scratch, ['-C', clone, 'push', 'origin', 'HEAD:refs/heads/main'], readToken.plaintext, 1);
  const readPushMs = Math.round(performance.now() - readPushStarted);
  const denialText = `${denied.stderr}\n${denied.stdout}`.toLowerCase();
  const denialClass = /401|403|unauthor|forbidden|permission|read.only|write access|not allowed|denied/.test(denialText) ? 'authorization_denied' : 'other_failure';
  if (denialClass !== 'authorization_denied') throw new Error('read-token push failed without a clear authorization denial');
  const pushed = git(scratch, ['-C', clone, 'push', 'origin', 'HEAD:refs/heads/main'], writeToken.plaintext);
  const lsRemote = git(scratch, ['-C', clone, 'ls-remote', 'origin', 'refs/heads/main'], readToken.plaintext).stdout.trim().split(/\s+/)[0];
  const fetched = git(scratch, ['-C', clone, 'fetch', 'origin', 'main'], readToken.plaintext);
  const verifyDir = path.join(scratch, 'independent-verification-clone');
  const verifyClone = git(scratch, ['clone', '--branch', 'main', remote, verifyDir], readToken.plaintext);
  const verifyHead = git(scratch, ['-C', verifyDir, 'rev-parse', 'HEAD'], readToken.plaintext).stdout.trim();
  const verifyContent = await readFile(path.join(verifyDir, fixturePath));
  const readback = await getReadback();
  const body = readback.body;
  const contentSha256 = createHash('sha256').update(fixture).digest('hex');
  const checks = {
    commitSha: body.head === commit,
    treeSha: body.tree === tree,
    parentSha: JSON.stringify(body.parents) === JSON.stringify(parent ? [parent] : []),
    fixturePath: body.fixture?.path === fixturePath,
    fixtureContentSha256: body.fixture?.fileContentSha256 === contentSha256,
    fixtureBytes: body.fixture?.content === fixture.toString('utf8') && Buffer.compare(verifyContent, fixture) === 0,
    remoteHead: lsRemote === commit && verifyHead === commit,
  };
  output = {
    gitVersion: version.stdout.trim(), namespace, repository: body.repository,
    initial: { ref: `refs/heads/${initialBranch}`, sha: initialHead, workerHead: initial.body.head },
    credentials: { read: { id: readToken.id, scope: readToken.scope, expiresAt: readToken.expiresAt }, write: { id: writeToken.id, scope: writeToken.scope, expiresAt: writeToken.expiresAt } },
    clone: { exitStatus: cloneResult.status, elapsedMs: cloneResult.elapsedMs, initialCheckout: initialHead ? 'existing-head-checked-out' : 'empty-repository-root-commit' },
    commit: { parentSha: parent, commitSha: commit, treeSha: tree, fixturePath, fixtureContentSha256: contentSha256 },
    readPush: { exitStatus: denied.status, elapsedMs: readPushMs, classification: denialClass },
    writePush: { exitStatus: pushed.status, elapsedMs: pushed.elapsedMs },
    fetch: { exitStatus: fetched.status, elapsedMs: fetched.elapsedMs },
    independentClone: { exitStatus: verifyClone.status, elapsedMs: verifyClone.elapsedMs, sha: verifyHead },
    readback: { status: readback.status, ref: body.ref, head: body.head, tree: body.tree, parents: body.parents, fixture: body.fixture },
    checks,
    exactIdentityMatch: Object.values(checks).every(Boolean),
  };
} catch (error) {
  output = { error: error instanceof Error ? error.message : 'unknown failure', issuedTokens: issued.map(({ id, scope, expiresAt }) => ({ id, scope, expiresAt })) };
  process.exitCode = 1;
} finally {
  const revoked = [];
  for (const item of issued) revoked.push(await revoke(item.id));
  output = { ...output, cleanup: { revoked } };
  await rm(scratch, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
