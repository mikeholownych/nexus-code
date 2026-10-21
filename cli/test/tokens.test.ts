import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { countTokens } from "../src/tokens.js";
import { LocalLlmClient } from "../src/client.js";
import { parseTokenizeResponse } from "../src/core/provider_capabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "token_calibration.json");

interface CalibrationEntry {
  name: string;
  kind: string;
  repeat?: [string, number];
  generator?: string;
  referenceTokens: number;
  floorBound?: boolean;
  floorTokens?: number;
  note?: string;
}

interface CalibrationFixture {
  tokenizer: {
    id: string;
    limitsVersion: string;
    capturedAt: string;
    templateOverheadTokens: number;
  };
  corpora: CalibrationEntry[];
}

function materializeCorpus(entry: CalibrationEntry): string {
  if (entry.repeat) {
    const [unit, times] = entry.repeat;
    return unit.repeat(times);
  }
  if (entry.generator === "minified_json_50") {
    return JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, k: "v" + i, ok: true })));
  }
  if (entry.generator === "base64_3072_7") {
    return Buffer.alloc(3072, 7).toString("base64");
  }
  if (entry.generator === "base64_lcg_3072") {
    const b = Buffer.alloc(3072);
    let x = 12345;
    for (let i = 0; i < b.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      b[i] = (x >> 16) & 255;
    }
    return b.toString("base64");
  }
  if (entry.generator === "base64_text_120") {
    return Buffer.from("Hello world 1234567890!@# ".repeat(120)).toString("base64");
  }
  if (entry.generator === "hex_sha256_20") {
    return Array.from({ length: 20 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
  }
  throw new Error(`Unknown corpus generator: ${entry.generator}`);
}

describe("ACC-VER-07 & REQ-AGT-118: Conservative token estimator and calibration", () => {
  test("long whitespace runs are processed without changing conservative counts", () => {
    const run = " ".repeat(131_072);
    assert.equal(countTokens(run), Math.ceil(run.length / 3));
    assert.equal(countTokens(`${run}a`), Math.ceil((run.length - 1) / 3) + 1);
    const tabs = "\t".repeat(131_072);
    assert.equal(countTokens(`${tabs}a`), Math.ceil((tabs.length - 1) / 3) + 2);
  });

  test("ACC-VER-07: countTokens is within 1.5x of pinned tokenizer reference counts (floor-bound corpora excepted per DEC-17)", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as CalibrationFixture;
    assert.ok(fixture.corpora.length >= 8, "calibration fixture must contain all required corpora");
    // The pinned corpora are the calibration evidence: none may be silently deleted, and any new corpus
    // must run through the band/floor logic below (DEC-17: examined and recorded, not exempted by default).
    const pinnedCorpora = [
      "english prose (200 words)",
      "CJK one 400-char run",
      "CJK 16-char classical x 25",
      "CJK 7-char sentences x 50",
      "Kana 200 chars",
      "Hangul 200 chars",
      "digits 1000",
      "minified JSON",
      "base64 4KB",
      "base64 random 3072B (LCG seed 12345)",
      "base64 of text",
      "hex sha256 x20",
      "whitespace-indented code",
      "emoji 100",
    ];
    for (const name of pinnedCorpora) {
      assert.ok(fixture.corpora.some((c) => c.name === name), `calibration fixture must still contain corpus "${name}"`);
    }

    const floorBound: string[] = [];
    for (const entry of fixture.corpora) {
      const text = materializeCorpus(entry);
      const estimated = countTokens(text);
      const ref = entry.referenceTokens;
      // Conservative: never under-estimate by more than 20% (A2 §6, R-VER-10).
      assert.ok(estimated >= ref * 0.8, `${entry.name}: estimated=${estimated} under-estimates reference=${ref}`);
      const ratio = estimated >= ref ? estimated / ref : ref / estimated;
      if (entry.floorBound) {
        // DEC-17: REQ-AGT-118's >= 1 token/character floor dominates a merging tokenizer here.
        // The over-estimate is an accepted, bounded safety bias: it must never under-count, and the
        // floor (one token per CJK/Hangul char) must be applied exactly. Preserved as evidence, not hidden.
        assert.ok(estimated >= ref, `${entry.name}: a floor-bound corpus must remain an over-estimate`);
        assert.equal(estimated, entry.floorTokens, `${entry.name}: the >= 1 token/char floor must be applied exactly`);
        floorBound.push(`${entry.name} ratio=${ratio.toFixed(2)}`);
        continue;
      }
      assert.ok(ratio <= 1.5, `${entry.name}: estimated=${estimated} vs reference=${ref} (ratio=${ratio.toFixed(3)} exceeds 1.5x)`);
    }
    // Only the two merging-script corpora may sit above the band (DEC-17); a new one must be examined and recorded, not silently added.
    assert.deepEqual(floorBound.map((c) => c.split(" ratio=")[0]).sort(), ["CJK 7-char sentences x 50", "Hangul 200 chars"]);
  });

  test("REQ-AGT-118: conservative script and symbol rules (>= 1 per CJK/Hangul/kana, 1 per digit, len/3 for base64)", () => {
    const cjk = "测试中文字符计数".repeat(25); // 200 Han chars
    assert.ok(countTokens(cjk) >= 200, `expected >= 200 tokens for 200 CJK chars, got ${countTokens(cjk)}`);

    const hangul = "한국어토큰계산기".repeat(25); // 200 Hangul chars
    assert.ok(countTokens(hangul) >= 200, `expected >= 200 tokens for 200 Hangul chars, got ${countTokens(hangul)}`);

    const kana = "あいうえおアイウエオ".repeat(20); // 200 Kana chars
    assert.ok(countTokens(kana) >= 200, `expected >= 200 tokens for 200 Kana chars, got ${countTokens(kana)}`);

    const digits = "1234567890".repeat(100); // 1000 digits
    assert.equal(countTokens(digits), 1000, "expected 1 token per digit");

    const b64 = Buffer.from("NexusCodeV1TokenCalibrationTestPayload1234567890!@#".repeat(30)).toString("base64");
    assert.ok(countTokens(b64) >= Math.ceil(b64.length / 3), "expected at least ceil(len/3) tokens for a base64 run");
  });

  test("REQ-AGT-118: /tokenize works on llama.cpp (root /tokenize { tokens }) and vLLM (root /tokenize { count })", async () => {
    assert.deepEqual(parseTokenizeResponse({ tokens: [10, 20, 30, 40] }), {
      promptTokens: 4,
      source: "exact_sampled_worker",
    });
    assert.deepEqual(parseTokenizeResponse({ count: 128, max_model_len: 16384, tokens: [] }), {
      promptTokens: 128,
      source: "exact_sampled_worker",
      contextLength: 16384,
    });

    const seenUrls: string[] = [];
    let mode: "llamacpp" | "vllm" = "llamacpp";
    const srv = http.createServer((req, res) => {
      seenUrls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") {
        if (mode === "llamacpp") {
          res.end(JSON.stringify({ data: [{ id: "m", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }] }));
        } else {
          res.end(JSON.stringify({ data: [{ id: "m", object: "model", max_model_len: 16384 }] }));
        }
        return;
      }
      if (req.url === "/props") {
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }));
        return;
      }
      if (req.url === "/tokenize") {
        if (mode === "llamacpp") {
          res.end(JSON.stringify({ tokens: [1, 2, 3, 4, 5, 6, 7] }));
        } else {
          res.end(JSON.stringify({ count: 42, max_model_len: 16384 }));
        }
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const llamaClient = new LocalLlmClient({ endpoint, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
      await llamaClient.discoverAdvertisement();
      const llamaCount = await llamaClient.countRequestTokens([{ role: "user", content: "hello" }], [], "req-1");
      assert.equal(llamaCount.promptTokens, 7);
      assert.equal(llamaCount.source, "exact_sampled_worker");
      assert.ok(seenUrls.includes("POST /tokenize"), "llama.cpp root /tokenize should be called after /v1/tokenize 404s");

      mode = "vllm";
      const vllmClient = new LocalLlmClient({ endpoint, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
      await vllmClient.discoverAdvertisement();
      const vllmCount = await vllmClient.countRequestTokens([{ role: "user", content: "hello" }], [], "req-2");
      assert.equal(vllmCount.promptTokens, 42);
      assert.equal(vllmCount.contextLength, 16384);
      assert.equal(vllmCount.source, "exact_sampled_worker");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
