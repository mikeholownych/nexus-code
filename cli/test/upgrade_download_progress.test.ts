import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { downloadFile, formatDownloadProgressDetail, parseDownloadLength } from "../src/upgrade.js";

interface ProgressReport {
  bytes: number;
  total?: number;
}

async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("download progress detail bounds byte counts and percent", () => {
  assert.equal(formatDownloadProgressDetail(0, 1024), "Downloaded 0 B of 1.0 KiB (0%).");
  assert.equal(formatDownloadProgressDetail(512, 1024), "Downloaded 512 B of 1.0 KiB (50%).");
  assert.equal(formatDownloadProgressDetail(2048, 1024), "Downloaded 2.0 KiB of 1.0 KiB (100%).");
  assert.equal(formatDownloadProgressDetail(42, Number.POSITIVE_INFINITY), "Downloaded 42 B.");
  assert.equal(formatDownloadProgressDetail(Number.NaN, 1024), "Downloaded 0 B of 1.0 KiB (0%).");
  // Oversized or unsafe values are clamped instead of reaching progress output.
  assert.equal(formatDownloadProgressDetail(Number.MAX_SAFE_INTEGER, 1024), "Downloaded 250.0 MiB of 1.0 KiB (100%).");
});

test("parseDownloadLength rejects malformed and oversized headers", () => {
  assert.equal(parseDownloadLength(null), undefined);
  assert.equal(parseDownloadLength(" 10 "), 10);
  assert.throws(() => parseDownloadLength("ten"), /Invalid Content-Length header/);
  assert.throws(() => parseDownloadLength("99999999999999999999"), /exceeds maximum allowed limit/);
});

test("downloadFile rejects an oversized declared length before writing the archive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-download-oversize-"));
  const dest = path.join(dir, "archive");
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(Number.MAX_SAFE_INTEGER) });
    res.end("tiny");
  }, async (port) => {
    await assert.rejects(
      downloadFile(`http://127.0.0.1:${port}/archive`, dest, undefined, 5000),
      /exceeds maximum allowed limit/,
    );
  });
  try {
    assert.equal(fs.existsSync(dest), false, "no partial download is kept when the declared size is rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile reports byte progress with a declared content length", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-download-progress-"));
  const body = Buffer.from("0123456789");
  const reports: ProgressReport[] = [];
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.write(body.subarray(0, 4));
    setTimeout(() => res.end(body.subarray(4)), 30);
  }, async (port) => {
    await downloadFile(
      `http://127.0.0.1:${port}/archive`,
      path.join(dir, "archive"),
      undefined,
      5000,
      5,
      (bytes, total) => reports.push({ bytes, total }),
      0,
    );
  });
  try {
    assert.deepEqual(reports[0], { bytes: 0, total: body.length });
    assert.deepEqual(reports[reports.length - 1], { bytes: body.length, total: body.length });
    assert.ok(reports.length >= 2, "at least the initial and final byte counts are reported");
    for (const report of reports) {
      assert.ok(Number.isSafeInteger(report.bytes), "byte count is a safe integer");
      assert.ok(report.bytes >= 0 && report.bytes <= body.length, "byte count stays within the declared size");
      assert.equal(report.total, body.length);
    }
    assert.equal(fs.readFileSync(path.join(dir, "archive"), "utf8"), "0123456789");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile throttles intermediate progress and always reports the final count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-download-throttle-"));
  const chunk = Buffer.alloc(512, 7);
  const reports: ProgressReport[] = [];
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(chunk.length * 8) });
    for (let i = 0; i < 8; i++) res.write(chunk);
    res.end();
  }, async (port) => {
    await downloadFile(
      `http://127.0.0.1:${port}/archive`,
      path.join(dir, "archive"),
      undefined,
      5000,
      5,
      (bytes, total) => reports.push({ bytes, total }),
      10_000,
    );
  });
  try {
    assert.deepEqual(reports, [
      { bytes: 0, total: chunk.length * 8 },
      { bytes: chunk.length * 8, total: chunk.length * 8 },
    ]);
    assert.equal(fs.statSync(path.join(dir, "archive")).size, chunk.length * 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile drops an under-reported total instead of showing 100% early", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-download-short-header-"));
  const body = Buffer.from("0123456789");
  const reports: ProgressReport[] = [];
  const originalFetch = globalThis.fetch;
  // A real HTTP client stops at Content-Length; this fake body deliberately
  // overruns it so the progress callback's handling of a bad declaration is tested.
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 4));
        controller.enqueue(body.subarray(4));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Length": "4" } },
  )) as typeof fetch;
  try {
    await downloadFile(
      "http://127.0.0.1:1/archive",
      path.join(dir, "archive"),
      undefined,
      5000,
      5,
      (bytes, total) => reports.push({ bytes, total }),
      0,
    );
    assert.deepEqual(reports[0], { bytes: 0, total: 4 });
    assert.deepEqual(reports[reports.length - 1], { bytes: body.length, total: undefined });
    assert.match(formatDownloadProgressDetail(body.length, undefined), /^Downloaded 10 B\.$/);
    for (const report of reports) {
      assert.equal(report.total, report.bytes <= 4 ? 4 : undefined);
    }
    assert.equal(fs.readFileSync(path.join(dir, "archive"), "utf8"), body.toString());
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile survives a throwing progress consumer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-download-throwing-callback-"));
  const body = Buffer.from("progress must not break the download");
  let calls = 0;
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  }, async (port) => {
    await downloadFile(
      `http://127.0.0.1:${port}/archive`,
      path.join(dir, "archive"),
      undefined,
      5000,
      5,
      () => { calls += 1; throw new Error("consumer failed"); },
      0,
    );
  });
  try {
    assert.ok(calls >= 2, "initial and final progress callbacks are both attempted");
    assert.equal(fs.readFileSync(path.join(dir, "archive"), "utf8"), body.toString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
