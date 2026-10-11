import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const probe = new URL("./credential-probe-safe.mjs", import.meta.url);
const head = "ec3affd0e916b895e3528de6747b632f428359c0";

async function contains(root, value) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const target = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (await contains(target, value)) return true;
		} else if (entry.isFile() && (await readFile(target)).includes(Buffer.from(value))) return true;
	}
	return false;
}

async function main() {
	const root = await mkdtemp(path.join(os.tmpdir(), "credential-probe-safe-test-"));
	const canary = `synthetic-${randomBytes(32).toString("hex")}`;
	const stateFile = path.join(root, "state.json");
	const cfPath = path.join(root, "fake-cf.mjs");
	const hostileBin = path.join(root, "hostile-bin");
	const hostileNodeWasRun = path.join(root, "hostile-node-was-run");
	let fakeProgramHashes = null;
	let stage = "initialization";
	const cfSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const statePath=process.env.CF_FAKE_STATE;
const mode=process.env.CF_FAKE_MODE||'clean';
const args=process.argv.slice(2);
let state={id:'synthetic-token-id',active:false,log:[],ttl:300,cliArgvClean:true};
try{state=JSON.parse(fs.readFileSync(statePath,'utf8'))}catch{}
state.log??=[];state.log.push(args[3]||'unknown');state.cliArgvClean&&=!args.some(x=>x.includes(process.env.CF_TEST_CANARY));state.lastChildEnv={path:process.env.PATH,home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,lang:process.env.LANG,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,npmConfig:[...Object.keys(process.env).filter(k=>/^npm_config_/i.test(k))],cwd:process.cwd()};fs.writeFileSync(statePath,JSON.stringify(state));
if(args[0]==='artifacts'&&args.includes('list')){if(mode==='inventory-after-revoke-fail'&&state.revokedAttempt)process.exit(25);process.stdout.write(JSON.stringify(state.active?[{id:state.id}]:[]));process.exit(0)}
if(args[0]==='artifacts'&&args.includes('create')){
 state.active=true;const ttlIndex=args.indexOf('--ttl');state.ttl=ttlIndex>=0?Number(args[ttlIndex+1]):-1;fs.writeFileSync(statePath,JSON.stringify(state));
	 const value=mode==='missing-id'?{plaintext:process.env.CF_TEST_CANARY,scope:'read',expires_at:new Date(Date.now()+state.ttl*1000).toISOString()}:{id:state.id,plaintext:process.env.CF_TEST_CANARY,scope:'read',expires_at:new Date(Date.now()+state.ttl*1000).toISOString()};
 process.stdout.write(JSON.stringify(value));
 if(mode==='issuer-stderr')process.stderr.write(process.env.CF_TEST_CANARY);
 if(mode==='issue-fail')process.exit(23);process.exit(0)
}
if(args[0]==='artifacts'&&args.includes('revoke')){
	 state.revokedAttempt=true;if(mode==='revoke-fail')process.exit(24);state.active=false;fs.writeFileSync(statePath,JSON.stringify(state));process.exit(0)
}
		process.exit(80);`;
	const gitSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const mode=process.env.CF_FAKE_GIT_MODE||'clean';
const value=process.env.GIT_CONFIG_VALUE_0||'';
const expected=process.env.GIT_BROKER_TEST_EXPECTED||'';
const statePath=process.env.GIT_BROKER_TEST_STATE;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
function persist(name,value){fs.writeFileSync(path.join(process.cwd(),name),value);state.leakProduced=true;fs.writeFileSync(statePath,JSON.stringify(state))}
const exactCredential=value===('Authorization: Bearer '+expected);
const argvContainsCredential=process.argv.slice(2).some(x=>expected&&x.includes(expected));
fs.writeFileSync(process.env.GIT_BROKER_TEST_OBSERVATION_FILE,JSON.stringify({exactCredential,argvContainsCredential,path:process.env.PATH,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,npmConfig:[...Object.keys(process.env).filter(k=>/^npm_config_/i.test(k))]}));
if(!exactCredential)process.exit(70);
if(!state.active){if(mode==='post-revocation-reflection'){process.stdout.write(value);process.stderr.write('Authentication failed');process.exit(128)}process.stderr.write('Authentication failed');process.exit(128)}
if(mode==='git-stdout')process.stdout.write(value);
if(mode==='git-stderr')process.stderr.write(value);
if(mode==='git-file')fs.writeFileSync('credential-leak',value);
if(mode==='git-unreadable-file'){persist('unreadable-leak',value);fs.chmodSync(path.join(process.cwd(),'unreadable-leak'),0);}
if(mode==='git-config')persist('leaked-global-gitconfig','[http]\\n\\textraHeader = '+value+'\\n');
if(mode==='git-remote')persist('leaked-remote-url','https://user:'+expected+'@example.invalid/repo.git');
if(mode==='git-evidence')persist('leaked-evidence.json',JSON.stringify({credential:value}));
if(mode==='git-env')persist('leaked-environment.json',JSON.stringify({credential:process.env.GIT_CONFIG_VALUE_0}));
if(mode==='wait')await new Promise(resolve=>setTimeout(resolve,1500));
if(mode==='git-abnormal-exit')process.exit(77);
process.stdout.write('${head}\\tHEAD\\n');`;
	fakeProgramHashes = { cli: createHash("sha256").update(cfSource).digest("hex"), git: createHash("sha256").update(gitSource).digest("hex") };
	let outer = null;
	try {
		await writeFile(cfPath, cfSource, { mode: 0o700 });
		await chmod(cfPath, 0o700);
		await mkdir(hostileBin);
		await writeFile(path.join(hostileBin, "node"), `#!/bin/sh\nprintf injected > '${hostileNodeWasRun}'\nexit 91\n`, { mode: 0o700 });
		await chmod(path.join(hostileBin, "node"), 0o700);
		const cases = [
			["baseline", "clean", "clean", true, false],
			["issuer stderr", "issuer-stderr", "clean", false, false],
			["nonzero issuance after creation", "issue-fail", "clean", false, false],
			["malformed issuance ID", "missing-id", "clean", false, false],
			["Git stdout leak", "clean", "git-stdout", false, false],
			["Git stderr leak", "clean", "git-stderr", false, false],
			["Git file persistence", "clean", "git-file", false, false],
			["scan error cleanup", "clean", "git-unreadable-file", false, false],
			["Git config persistence", "clean", "git-config", false, false],
			["remote URL persistence", "clean", "git-remote", false, false],
			["evidence persistence", "clean", "git-evidence", false, false],
			["environment persistence", "clean", "git-env", false, false],
			["abnormal Git exit", "clean", "git-abnormal-exit", false, false],
			["revocation failure", "revoke-fail", "clean", false, false],
			["inventory failure after revoke", "inventory-after-revoke-fail", "clean", false, false],
			["Git argv guard", "clean", "clean", false, true],
			["post-revocation output reflection", "clean", "post-revocation-reflection", false, false],
		];
		const results = [];
		for (const [name, cfMode, gitMode, expected, argvInjection] of cases) {
			await rm(stateFile, { force: true });
			const gitPath = path.join(root, `fake-git-${results.length}.mjs`);
			await writeFile(gitPath, gitSource, { mode: 0o700 });
			await chmod(gitPath, 0o700);
			const observationPath = path.join(root, `git-observation-${results.length}.json`);
			const env = {
				...process.env,
				PATH: hostileBin,
				NODE_OPTIONS: "--no-warnings",
				NODE_PATH: path.join(root, "hostile-node-modules"),
				npm_config_userconfig: path.join(root, "hostile.npmrc"),
				CF_CLI_PATH: cfPath,
				GIT_CLI_PATH: gitPath,
				CF_FAKE_STATE: stateFile,
				CF_TEST_CANARY: canary,
				CF_FAKE_MODE: cfMode,
				CF_FAKE_GIT_MODE: gitMode,
				CF_BROKER_TEST_SCRATCH_ROOT: root,
				CF_BROKER_TEST_GIT_OBSERVATION: observationPath,
				GIT_BROKER_TEST_STATE: stateFile,
				GIT_BROKER_TEST_ROOT: root,
			};
			const run = spawnSync(process.execPath, [probe.pathname, "--synthetic-test", ...(argvInjection ? ["--synthetic-test-argv-leak"] : [])], { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
			let result;
			try { result = JSON.parse(run.stdout); } catch { result = null; }
			let mockState = null;
			try { mockState = JSON.parse(await readFile(stateFile, "utf8")); } catch {}
			let gitObservation = null;
			try { gitObservation = JSON.parse(await readFile(observationPath, "utf8")); } catch {}
			const outputClean = !run.stdout.includes(canary) && !run.stderr.includes(canary);
			const argvClean = ![process.execPath, probe.pathname].some((arg) => arg.includes(canary));
			const diskClean = !(await contains(root, canary));
			const outcomeCorrect = run.status === (expected ? 0 : 1) && result?.passed === expected && (argvInjection ? result?.argvGuardRejected === true : !result?.argvGuardRejected);
			const revoked = result?.revocationCommandSucceeded === true && mockState?.log?.includes("revoke") === true && mockState?.active === false;
			const expectedUnrevokedFailure = (cfMode === "missing-id" || cfMode === "revoke-fail") && mockState?.active === true && mockState?.ttl === 300 && result?.passed === false;
			const expectedUnknownInventoryFailure = cfMode === "inventory-after-revoke-fail" && mockState?.active === false && result?.tokenInventoryState === "unknown" && result?.credentialLifecycleState === "REVOCATION_AMBIGUOUS" && result?.revocationCommandSucceeded === true && result?.passed === false;
			const expectedState = name === "malformed issuance ID" ? "ISSUANCE_AMBIGUOUS" : name === "revocation failure" || name === "inventory failure after revoke" || name === "post-revocation output reflection" ? "REVOCATION_AMBIGUOUS" : name === "issuer stderr" || name === "nonzero issuance after creation" ? "REVOCATION_ATTEMPTED" : "REVOKED_CONFIRMED";
			const lifecycleCorrect = result?.credentialLifecycleState === expectedState;
			const expectedPersistedLeak = ["Git config persistence", "remote URL persistence", "evidence persistence", "environment persistence"].includes(name);
			const leakWitness = !expectedPersistedLeak || (mockState?.leakProduced === true && result?.persistentFilesClean === false);
			const outputReflectionWitness = name !== "post-revocation output reflection" || result?.postRevocationOutputClean === false;
			const inventoryUnknownWitness = name !== "inventory failure after revoke" || (result?.tokenInventoryState === "unknown" && result?.credentialLifecycleState === "REVOCATION_AMBIGUOUS");
			const cleanupExceptionWitness = name !== "scan error cleanup" || (mockState?.leakProduced === true && result?.scanErrorObserved === true && run.status === 1 && !(await readdir(root)).some((entry) => entry.startsWith("artifacts-read-probe-")) && await access(path.join(os.tmpdir(), "nexus-artifact-probe.lock")).then(() => false, () => true));
			const argvObservedClean = mockState?.cliArgvClean === true && (!gitObservation || gitObservation.argvContainsCredential === false);
			const environmentSafe = mockState?.lastChildEnv?.path === "/usr/bin:/bin" && mockState?.lastChildEnv?.home === "/home/mike" && mockState?.lastChildEnv?.xdg === "/home/mike/.config" && mockState?.lastChildEnv?.nodeOptions === null && mockState?.lastChildEnv?.nodePath === null && mockState?.lastChildEnv?.npmConfig?.length === 0 && mockState?.lastChildEnv?.cwd === "/" && (!gitObservation || (gitObservation.path === "/usr/bin:/bin" && gitObservation.nodeOptions === null && gitObservation.nodePath === null && gitObservation.npmConfig.length === 0)) && !(await access(hostileNodeWasRun).then(() => true, () => false));
			const exactSyntheticHandoff = result?.passed !== true || gitObservation?.exactCredential === true;
			results.push({ name, detected: outcomeCorrect && lifecycleCorrect && leakWitness && outputReflectionWitness && inventoryUnknownWitness && cleanupExceptionWitness && environmentSafe, exitStatus: run.status, probePassed: result?.passed === true, lifecycleState: result?.credentialLifecycleState, lifecycleCorrect, leakWitness, outputReflectionWitness, inventoryUnknownWitness, cleanupExceptionWitness, environmentSafe, exactSyntheticHandoff, argvObservedClean, revoked, remainsActive: mockState?.active === true, boundedTtlRequestedForAmbiguousFailure: expectedUnrevokedFailure, unknownInventoryFailsClosed: expectedUnknownInventoryFailure, tokenAbsent: result?.tokenAbsentFromInventory === true, outputClean, argvClean: argvClean && argvObservedClean, diskClean });
		}
		const waitGit = path.join(root, "fake-git-signal.mjs");
		stage = "signal-child";
		await writeFile(waitGit, gitSource, { mode: 0o700 });
		await chmod(waitGit, 0o700);
		await rm(stateFile, { force: true });
		const signalObservation = path.join(root, "git-observation-signal.json");
		const signalEnv = {
			...process.env,
			CF_CLI_PATH: cfPath,
			GIT_CLI_PATH: waitGit,
			CF_FAKE_STATE: stateFile,
			CF_TEST_CANARY: canary,
			CF_FAKE_MODE: "clean",
			CF_FAKE_GIT_MODE: "wait",
			CF_BROKER_TEST_SCRATCH_ROOT: root,
			CF_BROKER_TEST_GIT_OBSERVATION: signalObservation,
			GIT_BROKER_TEST_STATE: stateFile,
			GIT_BROKER_TEST_ROOT: root,
		};
		const signalChild = spawn(process.execPath, [probe.pathname, "--synthetic-test"], { cwd: root, env: signalEnv, stdio: ["ignore", "pipe", "pipe"] });
		const signalOut = [], signalErr = [];
		signalChild.stdout.on("data", (chunk) => signalOut.push(chunk));
		signalChild.stderr.on("data", (chunk) => signalErr.push(chunk));
		const signalClosed = new Promise((resolve) => signalChild.once("close", (code, signal) => resolve({ code, signal })));
		let observationReady = false;
		for (let i = 0; i < 100 && !observationReady; i += 1) {
			observationReady = await access(signalObservation).then(() => true, () => false);
			if (!observationReady) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!observationReady) {
			signalChild.kill("SIGKILL");
			await signalClosed;
			throw new Error("signal-test child did not reach the credential observation");
		}
		stage = "signal-observed";
		signalChild.kill("SIGTERM");
		const signalExit = await signalClosed;
		let signalResult = null, signalState = null;
		try { signalResult = JSON.parse(Buffer.concat(signalOut).toString("utf8")); } catch {}
		try { signalState = JSON.parse(await readFile(stateFile, "utf8")); } catch {}
		let signalGitObservation = null;
		try { signalGitObservation = JSON.parse(await readFile(signalObservation, "utf8")); } catch {}
		const signalCase = {
			name: "SIGTERM cleanup",
			detected: observationReady && signalExit.code === 1 && signalResult?.passed === false,
			revoked: signalResult?.revocationCommandSucceeded === true && signalState?.active === false,
			outputClean: !Buffer.concat(signalOut).includes(canary) && !Buffer.concat(signalErr).includes(canary),
			exactSyntheticHandoff: observationReady && signalGitObservation?.exactCredential === true,
			argvClean: !signalChild.spawnargs.some((arg) => arg.includes(canary)) && signalState?.cliArgvClean === true && signalGitObservation?.argvContainsCredential === false,
			diskClean: !(await contains(root, canary)),
		};
		results.push(signalCase);
		const realCfPathAttempt = spawnSync(process.execPath, [probe.pathname, "--synthetic-test"], {
			cwd: root,
			env: { ...process.env, CF_CLI_PATH: "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf", GIT_CLI_PATH: "/usr/bin/git", CF_TEST_CANARY: canary, CF_BROKER_TEST_SCRATCH_ROOT: root },
			encoding: "utf8",
			timeout: 5000,
	});
		let realCfBoundaryResult = null;
		try { realCfBoundaryResult = JSON.parse(realCfPathAttempt.stdout); } catch {}
		const realCfBoundary = realCfPathAttempt.status === 1 && realCfBoundaryResult?.isolatedFakeCommandsRequired === true && !realCfPathAttempt.stdout.includes(canary) && !realCfPathAttempt.stderr.includes(canary);
		const implicitLiveAttempt = spawnSync(process.execPath, [probe.pathname], { cwd: root, env: process.env, encoding: "utf8", timeout: 5000 });
		let implicitLiveResult = null;
		try { implicitLiveResult = JSON.parse(implicitLiveAttempt.stdout); } catch {}
		const implicitLiveBlocked = implicitLiveAttempt.status === 1 && implicitLiveResult?.explicitModeRequired === true && !implicitLiveAttempt.stdout.includes(canary) && !implicitLiveAttempt.stderr.includes(canary);
		const attackDir = path.join(root, "attack");
		await mkdir(attackDir);
		const symlinkPath = path.join(attackDir, "fake-cf.mjs");
		await symlink("/home/mike/.local/node-v24.11.1-linux-x64/bin/cf", symlinkPath);
		const symlinkAttempt = spawnSync(process.execPath, [probe.pathname, "--synthetic-test"], { cwd: root, env: { ...process.env, CF_CLI_PATH: symlinkPath, GIT_CLI_PATH: path.join(root, "fake-git-0.mjs"), CF_TEST_CANARY: canary, CF_BROKER_TEST_SCRATCH_ROOT: root }, encoding: "utf8", timeout: 5000 });
		let symlinkResult = null;
		try { symlinkResult = JSON.parse(symlinkAttempt.stdout); } catch {}
		const symlinkBlocked = symlinkAttempt.status === 1 && symlinkResult?.isolatedFakeCommandsRequired === true && !symlinkAttempt.stdout.includes(canary) && !symlinkAttempt.stderr.includes(canary);
		const wrapperPath = path.join(attackDir, "fake-git-wrapper.mjs");
		await writeFile(wrapperPath, "#!/usr/bin/env node\\nprocess.exit(0);\\n", { mode: 0o700 });
		const wrapperAttempt = spawnSync(process.execPath, [probe.pathname, "--synthetic-test"], { cwd: root, env: { ...process.env, CF_CLI_PATH: cfPath, GIT_CLI_PATH: wrapperPath, CF_TEST_CANARY: canary, CF_BROKER_TEST_SCRATCH_ROOT: root }, encoding: "utf8", timeout: 5000 });
		let wrapperResult = null;
		try { wrapperResult = JSON.parse(wrapperAttempt.stdout); } catch {}
		const wrapperBlocked = wrapperAttempt.status === 1 && wrapperResult?.isolatedFakeCommandsRequired === true && !wrapperAttempt.stdout.includes(canary) && !wrapperAttempt.stderr.includes(canary);
		const passed = results.every((item) => item.detected && (item.revoked || item.boundedTtlRequestedForAmbiguousFailure || item.unknownInventoryFailsClosed) && item.outputClean && item.argvClean && item.diskClean && (item.name !== "baseline" && item.name !== "SIGTERM cleanup" || item.exactSyntheticHandoff)) && realCfBoundary && implicitLiveBlocked && symlinkBlocked && wrapperBlocked;
		outer = { syntheticOnly: true, cloudflareOperations: 0, cases: results, boundaryCases: { realCfPathRejected: realCfBoundary, implicitLiveModeRejected: implicitLiveBlocked, realCfSymlinkRejected: symlinkBlocked, wrapperRejected: wrapperBlocked }, fakeProgramHashes: { cli: createHash("sha256").update(cfSource).digest("hex"), git: createHash("sha256").update(gitSource).digest("hex") }, allCasesCorrect: passed, noCanaryInOutputArgvOrDisk: results.every((item) => item.outputClean && item.argvClean && item.diskClean) && !realCfPathAttempt.stdout.includes(canary) && !implicitLiveAttempt.stdout.includes(canary) && !symlinkAttempt.stdout.includes(canary) && !wrapperAttempt.stdout.includes(canary) };
		if (!passed) process.exitCode = 1;
	} catch {
		outer = { syntheticOnly: true, testHarnessErrorSuppressed: true, stage, fakeProgramHashes, passed: false };
		process.exitCode = 1;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	process.stdout.write(JSON.stringify(outer) + "\n");
}

main().catch(() => {
	process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: false, errorSuppressed: true }) + "\n");
	process.exitCode = 1;
});
