import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureCreateTokenHttpResponse, captureCreateTokenResponse, parseCreateTokenResponse } from "./artifacts-token-response.mjs";

const syntheticPlaintext = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=1791043200";
const validResult = Object.freeze({
	id: "0123456789abcdef",
	plaintext: syntheticPlaintext,
	scope: "write",
	expires_at: "2026-10-17T00:00:00.000Z",
});
const successEnvelope = (result = validResult) => ({ result, success: true, errors: [], messages: [] });

test("accepts the documented success envelope and hex-looking ID", () => {
	const parsed = parseCreateTokenResponse(successEnvelope());
	assert.equal(parsed.plaintext, syntheticPlaintext);
	assert.deepEqual(parsed.metadata, { id: validResult.id, scope: "write", expiresAt: validResult.expires_at });
});

test("accepts a non-hex string ID because the provider contract has no lexical restriction", () => {
	const result = parseCreateTokenResponse(successEnvelope({ ...validResult, id: "woh2sni4v09aj9hw" }));
	assert.equal(result.metadata.id, "woh2sni4v09aj9hw");
});

test("accepts an opaque non-empty ArtifactToken string without lexical assumptions", () => {
	const opaque = "opaque:synthetic/canary+value";
	const result = parseCreateTokenResponse(successEnvelope({ ...validResult, plaintext: opaque }));
	assert.equal(result.plaintext, opaque);
	assert.equal(result.metadata.id, validResult.id);
});

test("rejects missing and empty IDs without reflecting response content", () => {
	for (const result of [{ ...validResult, id: undefined }, { ...validResult, id: "" }]) {
		assert.throws(() => parseCreateTokenResponse(successEnvelope(result)), (error) => error.code === "TOKEN_CREATE_ID_INVALID" && !error.message.includes(syntheticPlaintext));
	}
});

test("rejects only structurally invalid plaintext values", () => {
	for (const plaintext of [undefined, null, 17, {}, ""]) {
		assert.throws(() => parseCreateTokenResponse(successEnvelope({ ...validResult, plaintext })), (error) => error.code === "TOKEN_CREATE_PLAINTEXT_INVALID");
	}
});

test("rejects an unsupported scope", () => {
	assert.throws(() => parseCreateTokenResponse(successEnvelope({ ...validResult, scope: "admin" })), (error) => error.code === "TOKEN_CREATE_SCOPE_INVALID");
});

test("rejects missing and invalid expiry values", () => {
	for (const expires_at of [undefined, "not-a-timestamp", "2026-02-30T00:00:00Z"]) {
		assert.throws(() => parseCreateTokenResponse(successEnvelope({ ...validResult, expires_at })), (error) => error.code === "TOKEN_CREATE_EXPIRY_INVALID");
	}
});

test("rejects provider failure and malformed envelopes", () => {
	assert.throws(() => parseCreateTokenResponse({ result: null, success: false, errors: [], messages: [] }), (error) => error.code === "TOKEN_CREATE_PROVIDER_FAILURE");
	for (const response of ["{", null, [], { success: true, result: null }]) {
		assert.throws(() => parseCreateTokenResponse(response));
	}
});

test("routes a canary to synthetic custody without output, argv, environment, evidence, or scratch leakage", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "artifact-token-capture-test-"));
	try {
		const protectedDir = path.join(root, "protected-custody");
		const ordinaryScratch = path.join(root, "ordinary-scratch");
		await mkdir(protectedDir, { mode: 0o700 });
		await mkdir(ordinaryScratch, { mode: 0o700 });
		const secretPath = path.join(protectedDir, "synthetic.token");
		const opaqueCanary = "opaque:synthetic/canary+value";
		const modulePath = new URL("./artifacts-token-response.mjs", import.meta.url).href;
		const childSource = `
			import { writeFile } from "node:fs/promises";
			const { captureCreateTokenHttpResponse } = await import(${JSON.stringify(modulePath)});
			let raw = ""; for await (const chunk of process.stdin) raw += chunk;
			const result = await captureCreateTokenHttpResponse(201, raw, (secret) => writeFile(${JSON.stringify(secretPath)}, secret, { mode: 0o400, flag: "wx" }));
			const canary = JSON.parse(raw).result.plaintext;
			const clean = !JSON.stringify(process.argv).includes(canary) && !JSON.stringify(process.env).includes(canary);
			process.stdout.write(JSON.stringify({ result, argumentsAndEnvironmentClean: clean }));
		`;
		const response = JSON.stringify(successEnvelope({ ...validResult, id: "nonhex-id/from-provider", plaintext: opaqueCanary }));
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
			input: response,
			encoding: "utf8",
			cwd: ordinaryScratch,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		assert.equal(child.status, 0, "synthetic capture subprocess succeeds");
		assert.equal(child.error, undefined);
		assert.equal(child.stdout.includes(opaqueCanary), false);
		assert.equal(child.stderr.includes(opaqueCanary), false);
		const outerResult = JSON.parse(child.stdout);
		const { metadata } = outerResult.result;
		const saved = await readFile(secretPath, "utf8");
		const savedStat = await stat(secretPath);
		const outputAndEvidence = JSON.stringify(metadata);
		assert.equal(saved, opaqueCanary);
		assert.equal(savedStat.mode & 0o777, 0o400);
		assert.equal(savedStat.uid, process.getuid());
		assert.equal(savedStat.gid, process.getgid());
		assert.equal(outerResult.argumentsAndEnvironmentClean, true);
		assert.deepEqual(metadata, { id: "nonhex-id/from-provider", scope: "write", expiresAt: validResult.expires_at });
		assert.equal(outputAndEvidence.includes(opaqueCanary), false);
		assert.deepEqual(outerResult.result, {
			httpStatus: 201,
			outcome: "CAPTURED",
			metadata: { id: "nonhex-id/from-provider", scope: "write", expiresAt: validResult.expires_at },
		});
		assert.deepEqual(await readdir(ordinaryScratch), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sanitized HTTP wrapper retains status without retaining provider plaintext", async () => {
	const rejected = await captureCreateTokenHttpResponse(403, { errors: [{ message: "synthetic detail" }] }, () => {
		throw new Error("sink must not be called for HTTP failure");
	});
	assert.deepEqual(rejected, { httpStatus: 403, outcome: "HTTP_FAILURE" });
	assert.equal(JSON.stringify(rejected).includes(syntheticPlaintext), false);

	const opaque = "opaque:status-canary";
	const malformed = await captureCreateTokenHttpResponse(201, successEnvelope({ ...validResult, plaintext: opaque, scope: "bad" }), () => {
		throw new Error("sink must not be called for invalid metadata");
	});
	assert.deepEqual(malformed, { httpStatus: 201, outcome: "RESPONSE_REJECTED", errorCode: "TOKEN_CREATE_SCOPE_INVALID" });
	assert.equal(JSON.stringify(malformed).includes(opaque), false);
	assert.equal(JSON.stringify(malformed).includes(syntheticPlaintext), false);
});
