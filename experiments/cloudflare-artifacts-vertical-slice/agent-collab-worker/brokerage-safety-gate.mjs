import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const canary = process.env.CF_BROKER_TEST_CANARY;
const safeEnv = (home, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C",
  GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});
const run = (command, args, env, cwd) => spawnSync(command, args, {
  cwd,
  env,
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 1024 * 1024,
});

async function scanFiles(root, needle) {
  const hits = [];
  async function visit(current) {
    // Any unreadable path makes the scan incomplete; fail closed.
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        let count = 0;
        let offset = 0;
        while ((offset = bytes.indexOf(needle, offset)) !== -1) {
          count += 1;
          offset += needle.length;
        }
        if (count) hits.push({ relativePath: path.relative(root, file), count });
      }
    }
  }
  await visit(root);
  return hits;
}

async function worker(mode, root) {
  const secret = process.env.CF_BROKER_TEST_CANARY;
  if (!secret || !root) process.exit(80);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const env = safeEnv(home);

  if (mode === "wait-for-signal") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "leak-stdout") process.stdout.write(secret);
  else if (mode === "leak-stderr") process.stderr.write(secret);
  else if (mode === "leak-env-file") await writeFile(path.join(home, ".profile"), `TOKEN=${secret}\n`);
  else if (mode === "leak-temp-file") await writeFile(path.join(root, "temp-secret"), secret);
  else if (mode === "leak-evidence") {
    const evidence = path.join(root, "evidence");
    await mkdir(evidence);
    await writeFile(path.join(evidence, "result.json"), JSON.stringify({ credential: secret }));
  } else if (mode === "leak-remote") {
    run("git", ["init", "--quiet", repo], env, root);
    run("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/repository.git"], env, root);
    run("git", ["-C", repo, "remote", "set-url", "origin", `https://${secret}@example.invalid/repository.git`], env, root);
  } else if (mode === "leak-local-config" || mode === "leak-global-config") {
    run("git", ["init", "--quiet", repo], env, root);
    const args = mode === "leak-local-config"
      ? ["-C", repo, "config", "http.extraHeader", `Authorization: Bearer ${secret}`]
      : ["config", "--global", "http.extraHeader", `Authorization: Bearer ${secret}`];
    run("git", args, env, root);
  } else if (mode === "argv-leak" || mode === "token-only-argv-leak") {
    const leakedValue = mode === "argv-leak" ? `Authorization: Bearer ${secret}` : secret;
    const args = ["-e", "process.exit(0)", leakedValue];
    const child = run(process.execPath, args, env, root);
    const argvContainsToken = args.some((arg) => arg.includes(secret));
    const argvHasHeader = args.some((arg) => arg.includes(`Authorization: Bearer ${secret}`));
    const argvHasTokenOnly = args.some((arg) => arg === secret);
    process.stdout.write(JSON.stringify({ argvContainsToken, argvHasHeader, argvHasTokenOnly, childExit: child.status }));
    return;
  } else if (mode === "cleanup-failure" || mode === "cleanup-missing-id") {
    const syntheticTokenId = mode === "cleanup-failure" ? "synthetic-token-id" : undefined;
    const revoke = async (id) => mode !== "cleanup-failure" && id === "synthetic-token-id";
    const revoked = await revoke(syntheticTokenId);
    process.stdout.write(JSON.stringify({ cleanupConfirmed: revoked }));
    process.exitCode = revoked ? 0 : 81;
    return;
  } else if (mode === "safe-handoff") {
    const init = run("git", ["init", "--quiet", repo], env, root);
    const remote = run("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/repository.git"], env, root);
    if (init.status !== 0 || remote.status !== 0) process.exit(82);
    const header = `Authorization: Bearer ${secret}`;
    const gitEnv = safeEnv(home, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: header,
    });
    const expected = createHash("sha256").update(header).digest("hex");
    const childCode = `const c=require('node:crypto');const v=process.env.GIT_CONFIG_VALUE_0??'';process.stdout.write(JSON.stringify({credentialReceived:c.createHash('sha256').update(v).digest('hex')===process.env.EXPECTED}));`;
    const childArgs = ["-e", childCode];
    const child = run(process.execPath, childArgs, { ...gitEnv, EXPECTED: expected }, root);
    const config = run("git", ["-C", repo, "config", "--local", "--get-regexp", "^http\\..*extraheader$"], env, root);
    const globalConfig = run("git", ["config", "--global", "--get-regexp", "^http\\..*extraheader$"], env, root);
    const url = run("git", ["-C", repo, "remote", "get-url", "origin"], env, root);
    let childResult;
    try { childResult = JSON.parse(child.stdout); } catch { process.exit(83); }
    process.stdout.write(JSON.stringify({
      childReceivedCredential: child.status === 0 && childResult.credentialReceived === true,
      tokenInChildArgv: childArgs.some((arg) => arg.includes(secret)),
      tokenInChildOutput: child.stdout.includes(secret) || child.stderr.includes(secret),
      persistentGitConfigClean: config.status === 1 && globalConfig.status === 1,
      remoteCredentialFree: url.status === 0 && url.stdout.trim() === "https://example.invalid/repository.git",
      brokerEnvironmentPersisted: false,
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ workerCompleted: true }));
}

async function spawnCaptured(args, env, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      args,
    }));
  });
}

async function testAbnormalTermination(base, secret) {
  const root = await mkdtemp(path.join(os.tmpdir(), "broker-gate-abnormal-"));
  let wasTerminated = false;
  let cleanupAttempted = false;
  let childOutputClean = false;
  let childArgvClean = false;
  let childScratchClean = false;
  try {
    const child = spawn(process.execPath, [script, "--worker", "wait-for-signal", root], {
      env: safeEnv(root, { CF_BROKER_TEST_CANARY: secret }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const exit = await closed;
    wasTerminated = exit.signal === "SIGTERM";
    const capturedStdout = Buffer.concat(stdout);
    const capturedStderr = Buffer.concat(stderr);
    childOutputClean = !capturedStdout.includes(secret) && !capturedStderr.includes(secret);
    childArgvClean = !child.spawnargs.some((arg) => arg.includes(secret));
    childScratchClean = (await scanFiles(root, Buffer.from(secret))).length === 0;
  } finally {
    // This is a synthetic supervisor cleanup hook; it models fail-closed cleanup only.
    cleanupAttempted = true;
    await rm(root, { recursive: true, force: true });
  }
  return {
    detected: wasTerminated && cleanupAttempted && childOutputClean && childArgvClean && childScratchClean,
    childOutputClean,
    childArgvClean,
    childScratchClean,
  };
}

async function suite(root, secret) {
  const cases = [
    ["stdout", "leak-stdout", "stdout"],
    ["stderr", "leak-stderr", "stderr"],
    ["environmentPersistence", "leak-env-file", "file"],
    ["temporaryFile", "leak-temp-file", "file"],
    ["evidence", "leak-evidence", "file"],
    ["remoteUrl", "leak-remote", "file"],
    ["localGitConfig", "leak-local-config", "file"],
    ["globalGitConfig", "leak-global-config", "file"],
  ];
  const negativeControls = {};
  for (const [name, mode, channel] of cases) {
    const caseRoot = await mkdtemp(path.join(os.tmpdir(), `broker-gate-${name}-`));
    try {
      const child = await spawnCaptured([script, "--worker", mode, caseRoot], safeEnv(caseRoot, { CF_BROKER_TEST_CANARY: secret }), caseRoot);
      const found = channel === "stdout" ? child.stdout.includes(secret) : channel === "stderr" ? child.stderr.includes(secret) : (await scanFiles(caseRoot, Buffer.from(secret))).length > 0;
      negativeControls[name] = found;
    } finally { await rm(caseRoot, { recursive: true, force: true }); }
  }

  const argvRoot = await mkdtemp(path.join(os.tmpdir(), "broker-gate-argv-"));
  try {
    for (const name of ["argv", "tokenOnlyArgv"]) {
      const expectedArg = name === "argv" ? `Authorization: Bearer ${secret}` : secret;
      const args = [script, "--worker", name === "argv" ? "argv-leak" : "token-only-argv-leak", argvRoot, expectedArg];
      const child = await spawnCaptured(args, safeEnv(argvRoot, { CF_BROKER_TEST_CANARY: secret }), argvRoot);
      let observation;
      try { observation = JSON.parse(child.stdout.toString("utf8")); } catch { observation = null; }
      negativeControls[name] = child.code === 0
        && child.args.some((arg) => arg.includes(secret))
        && child.args.includes(expectedArg)
        && observation?.argvContainsToken === true
        && (name === "argv" ? observation.argvHasHeader === true : observation.argvHasTokenOnly === true);
    }
  } finally { await rm(argvRoot, { recursive: true, force: true }); }

  const safeRoot = await mkdtemp(path.join(os.tmpdir(), "broker-gate-safe-"));
  let safe;
  try {
    const child = await spawnCaptured([script, "--worker", "safe-handoff", safeRoot], safeEnv(safeRoot, { CF_BROKER_TEST_CANARY: secret }), safeRoot);
    const summary = JSON.parse(child.stdout.toString("utf8"));
    safe = {
      exitedSuccessfully: child.code === 0,
      childReceivedCredential: summary.childReceivedCredential === true,
      noTokenInWorkerOutput: !child.stdout.includes(secret) && !child.stderr.includes(secret),
      noTokenInWorkerArgv: summary.tokenInChildArgv === false && !child.args.some((arg) => arg.includes(secret)),
      noTokenInGitChildOutput: summary.tokenInChildOutput === false,
      persistentGitConfigClean: summary.persistentGitConfigClean === true,
      remoteCredentialFree: summary.remoteCredentialFree === true,
      noCanaryFiles: (await scanFiles(safeRoot, Buffer.from(secret))).length === 0,
    };
  } finally { await rm(safeRoot, { recursive: true, force: true }); }

  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), "broker-gate-cleanup-"));
  let cleanupFailureDetected, cleanupMissingIdDetected;
  try {
    const child = await spawnCaptured([script, "--worker", "cleanup-failure", cleanupRoot], safeEnv(cleanupRoot, { CF_BROKER_TEST_CANARY: secret }), cleanupRoot);
    const output = child.stdout.toString("utf8");
    const cleanupFailureScratchClean = (await scanFiles(cleanupRoot, Buffer.from(secret))).length === 0;
    cleanupFailureDetected = child.code !== 0 && output.includes('"cleanupConfirmed":false') && !child.stdout.includes(secret) && !child.stderr.includes(secret) && cleanupFailureScratchClean;
    const missingId = await spawnCaptured([script, "--worker", "cleanup-missing-id", cleanupRoot], safeEnv(cleanupRoot, { CF_BROKER_TEST_CANARY: secret }), cleanupRoot);
    const cleanupMissingIdScratchClean = (await scanFiles(cleanupRoot, Buffer.from(secret))).length === 0;
    cleanupMissingIdDetected = missingId.code !== 0 && missingId.stdout.toString("utf8").includes('"cleanupConfirmed":false') && !missingId.stdout.includes(secret) && !missingId.stderr.includes(secret) && cleanupMissingIdScratchClean;
  } finally { await rm(cleanupRoot, { recursive: true, force: true }); }

  const abnormal = await testAbnormalTermination(root, secret);
  const allNegativeControlsDetected = Object.values(negativeControls).every(Boolean);
  const safeHandoffPassed = Object.values(safe).every(Boolean);
  const result = {
    syntheticOnly: true,
    noCloudflareOperations: true,
    safeHandoffPassed,
    negativeControls,
    allNegativeControlsDetected,
    cleanupFailureDetected,
    cleanupMissingIdDetected,
    abnormalTerminationParentCleanupRan: abnormal.detected,
    abnormalTerminationOutputClean: abnormal.childOutputClean,
    abnormalTerminationArgvClean: abnormal.childArgvClean,
    abnormalTerminationScratchClean: abnormal.childScratchClean,
    noPlaintextInEvidence: false,
    scratchRemoved: true,
    gatePassed: safeHandoffPassed && allNegativeControlsDetected && cleanupFailureDetected && cleanupMissingIdDetected && abnormal.detected,
  };
  const evidenceDir = path.join(root, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "synthetic-gate-result.json"), JSON.stringify(result));
  result.noPlaintextInEvidence = (await scanFiles(root, Buffer.from(secret))).length === 0;
  result.gatePassed &&= result.noPlaintextInEvidence;
  return result;
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4]);
} else if (process.argv[2] === "--suite") {
  const result = await suite(process.argv[3], canary);
  const text = JSON.stringify(result);
  if (text.includes(canary)) {
    process.exitCode = 90;
    process.stdout.write(`${JSON.stringify({ syntheticOnly: true, gatePassed: false, suiteSummaryLeakDetected: true })}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  if (!result.gatePassed) process.exitCode = 91;
} else {
  const secret = `synthetic-${randomBytes(32).toString("hex")}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "brokerage-safety-gate-"));
  try {
    const suiteChild = await spawnCaptured([script, "--suite", root], safeEnv(root, { CF_BROKER_TEST_CANARY: secret }), root);
    let result;
    try { result = JSON.parse(suiteChild.stdout.toString("utf8")); } catch { result = null; }
    const suiteOutputClean = !suiteChild.stdout.includes(secret) && !suiteChild.stderr.includes(secret);
    const suiteArgvClean = !suiteChild.args.some((arg) => arg.includes(secret));

    const stdoutControl = await spawnCaptured(["-e", "process.stdout.write(process.env.CF_BROKER_TEST_CANARY)"], safeEnv(root, { CF_BROKER_TEST_CANARY: secret }), root);
    const stderrControl = await spawnCaptured(["-e", "process.stderr.write(process.env.CF_BROKER_TEST_CANARY)"], safeEnv(root, { CF_BROKER_TEST_CANARY: secret }), root);
    const outerOutputLeakControlsDetected = stdoutControl.stdout.includes(secret) && stderrControl.stderr.includes(secret);

    const final = {
      ...(result ?? { gatePassed: false, suiteResultParseFailed: true }),
      outerSuiteExitZero: suiteChild.code === 0,
      outerSuiteOutputClean: suiteOutputClean,
      outerSuiteArgvClean: suiteArgvClean,
      outerOutputLeakControlsDetected,
      processEnvironmentClean: process.env.CF_BROKER_TEST_CANARY === undefined,
    };
    final.gatePassed = final.gatePassed === true && suiteChild.code === 0 && suiteOutputClean && suiteArgvClean && outerOutputLeakControlsDetected && final.processEnvironmentClean;
    const provisionalText = JSON.stringify(final);
    final.canaryAbsentFromFinalSummary = !provisionalText.includes(secret);
    final.gatePassed &&= final.canaryAbsentFromFinalSummary;
    const finalText = JSON.stringify(final);
    if (finalText.includes(secret)) {
      process.exitCode = 92;
      process.stdout.write(`${JSON.stringify({ syntheticOnly: true, gatePassed: false, finalSummaryLeakDetected: true })}\n`);
    } else {
      if (!final.gatePassed) process.exitCode = 93;
      process.stdout.write(`${finalText}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
