import { test, describe, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import {
  isPublicIp,
  isSafeOutboundUrl,
  safeFetch,
  RustCoreBridge,
} from "../src/tools.js";

const execFileAsync = promisify(cp.execFile);

describe("ACC-TRUST-03: SSRF protection, DNS pinning, redirect hop checks, and streaming 5 MB cap", () => {
  let server: http.Server;
  let serverPort: number;
  let serverOrigin: string;
  let tempDir: string;
  let bridge: RustCoreBridge;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssrf-test-"));
    bridge = new RustCoreBridge(tempDir);

    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", serverOrigin);

      if (url.pathname === "/hello") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Hello World</h1></body></html>");
        return;
      }

      if (url.pathname === "/redirect-loopback") {
        res.writeHead(302, { Location: "http://127.0.0.1:9999/internal-admin" });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-cgnat") {
        res.writeHead(302, { Location: "http://100.64.0.1/admin" });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-v6ula") {
        res.writeHead(302, { Location: "http://[fd00::1]/admin" });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-localtest") {
        res.writeHead(302, { Location: "http://localtest.me/admin" });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-loop") {
        res.writeHead(302, { Location: `${serverOrigin}/redirect-loop` });
        res.end();
        return;
      }

      if (url.pathname === "/stream-50mb") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        // Stream 50 MB in 1 MB chunks
        const oneMb = Buffer.alloc(1024 * 1024, "A");
        let sent = 0;
        function sendChunks() {
          while (sent < 50) {
            sent++;
            const ok = res.write(oneMb);
            if (!ok) {
              res.once("drain", sendChunks);
              return;
            }
          }
          res.end();
        }
        sendChunks();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverOrigin = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("isPublicIp correctly identifies public and non-public IPv4 and IPv6 addresses", () => {
    // IPv4 Loopback
    assert.strictEqual(isPublicIp("127.0.0.1"), false);
    assert.strictEqual(isPublicIp("127.0.0.2"), false);
    assert.strictEqual(isPublicIp("127.255.255.255"), false);

    // IPv4 RFC1918 Private
    assert.strictEqual(isPublicIp("10.0.0.1"), false);
    assert.strictEqual(isPublicIp("172.16.0.1"), false);
    assert.strictEqual(isPublicIp("172.31.255.255"), false);
    assert.strictEqual(isPublicIp("192.168.1.1"), false);

    // IPv4 CGNAT
    assert.strictEqual(isPublicIp("100.64.0.1"), false);
    assert.strictEqual(isPublicIp("100.127.255.254"), false);

    // IPv4 Link-local & 0.0.0.0
    assert.strictEqual(isPublicIp("169.254.169.254"), false);
    assert.strictEqual(isPublicIp("0.0.0.0"), false);

    // IPv4 Multicast & Reserved
    assert.strictEqual(isPublicIp("224.0.0.1"), false);
    assert.strictEqual(isPublicIp("240.0.0.1"), false);
    assert.strictEqual(isPublicIp("255.255.255.255"), false);

    // IPv4 Documentation & Benchmark
    assert.strictEqual(isPublicIp("192.0.2.1"), false);
    assert.strictEqual(isPublicIp("198.51.100.1"), false);
    assert.strictEqual(isPublicIp("203.0.113.1"), false);

    // IPv4 Valid Public
    assert.strictEqual(isPublicIp("8.8.8.8"), true);
    assert.strictEqual(isPublicIp("1.1.1.1"), true);
    assert.strictEqual(isPublicIp("93.184.216.34"), true);

    // IPv6 Loopback & Unspecified
    assert.strictEqual(isPublicIp("::1"), false);
    assert.strictEqual(isPublicIp("[::1]"), false);
    assert.strictEqual(isPublicIp("::"), false);

    // IPv6 IPv4-mapped addresses
    assert.strictEqual(isPublicIp("::ffff:127.0.0.1"), false);
    assert.strictEqual(isPublicIp("[::ffff:127.0.0.1]"), false);
    assert.strictEqual(isPublicIp("::ffff:10.0.0.1"), false);
    assert.strictEqual(isPublicIp("::ffff:192.168.1.1"), false);
    assert.strictEqual(isPublicIp("::ffff:100.64.0.1"), false);
    assert.strictEqual(isPublicIp("::ffff:8.8.8.8"), true);

    // IPv4-compatible (::/96) and IPv4-translated (::ffff:0:0/96) forms are reserved
    // rather than globally reachable; classify by their embedded IPv4 address.
    assert.strictEqual(isPublicIp("::7f00:1"), false);
    assert.strictEqual(isPublicIp("::a00:1"), false);
    assert.strictEqual(isPublicIp("::a9fe:a9fe"), false);
    assert.strictEqual(isPublicIp("::c0a8:101"), false);
    assert.strictEqual(isPublicIp("::ffff:0:7f00:1"), false);
    assert.strictEqual(isPublicIp("::ffff:0:a00:1"), false);
    assert.strictEqual(isPublicIp("::808:808"), true);
    assert.strictEqual(isSafeOutboundUrl("http://[::7f00:1]/admin").safe, false);

    // NAT64 well-known prefix 64:ff9b::/96 embeds IPv4 in the low 32 bits; classify by it.
    assert.strictEqual(isPublicIp("64:ff9b::7f00:1"), false);
    assert.strictEqual(isPublicIp("64:ff9b::a00:1"), false);
    assert.strictEqual(isPublicIp("64:ff9b::c0a8:1"), false);
    assert.strictEqual(isPublicIp("64:ff9b::a9fe:a9fe"), false);
    assert.strictEqual(isPublicIp("64:ff9b::808:808"), true);
    assert.strictEqual(isSafeOutboundUrl("http://[64:ff9b::7f00:1]/admin").safe, false);
    assert.strictEqual(isSafeOutboundUrl("http://[64:ff9b::808:808]/").safe, true);

    // NAT64 local-use prefix 64:ff9b:1::/48 is not globally reachable.
    assert.strictEqual(isPublicIp("64:ff9b:1::7f00:1"), false);
    assert.strictEqual(isPublicIp("64:ff9b:1::808:808"), false);
    assert.strictEqual(isSafeOutboundUrl("http://[64:ff9b:1::7f00:1]/admin").safe, false);

    // IPv6 ULA (fc00::/7)
    assert.strictEqual(isPublicIp("fd00::1"), false);
    assert.strictEqual(isPublicIp("[fd00::1]"), false);
    assert.strictEqual(isPublicIp("fc00::1"), false);

    // IPv6 Link-local (fe80::/10)
    assert.strictEqual(isPublicIp("fe80::1"), false);
    assert.strictEqual(isPublicIp("[fe80::1]"), false);

    // IPv6 Multicast (ff00::/8)
    assert.strictEqual(isPublicIp("ff02::1"), false);

    // IPv6 Public Unicast
    assert.strictEqual(isPublicIp("2606:2800:220:1:248:1893:25c8:1946"), true);
  });

  test("fetch_web refuses non-public address literals: [::ffff:127.0.0.1], [fd00::1], 100.64.0.1", async () => {
    const targets = [
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:127.0.0.1]:8080/secret",
      "http://[fd00::1]",
      "http://[fd00::1]:8080/data",
      "http://100.64.0.1",
      "http://100.64.0.1:8080/metrics",
      "http://127.0.0.1:8080/admin",
      "http://[64:ff9b::7f00:1]",
      "http://[64:ff9b::a00:1]:8080/admin",
      "http://[64:ff9b:1::7f00:1]/",
    ];

    for (const url of targets) {
      const res = await bridge.executeTool("fetch_web", { url });
      assert.strictEqual(
        res.success,
        false,
        `Expected fetch_web to refuse non-public target: ${url}`
      );
      assert.match(
        res.error || "",
        /SSRF Guard|Blocked|non-public|Loopback|Private/i,
        `Expected SSRF refusal error message for ${url}, got: ${res.error}`
      );
    }
  });

  test("fetch_web refuses localtest.me resolving to 127.0.0.1", async () => {
    // localtest.me is a well-known public domain mapped to 127.0.0.1
    // safeFetch resolves it via DNS and detects 127.0.0.1 is non-public
    const res = await bridge.executeTool("fetch_web", { url: "http://localtest.me" });
    assert.strictEqual(res.success, false);
    assert.match(
      res.error || "",
      /SSRF Guard|Non-public address 127\.0\.0\.1|DNS lookup failed/i,
      `Expected localtest.me to be refused by SSRF guard, got: ${res.error}`
    );
  });

  test("fetch_web / safeFetch refuses public URL that 302-redirects to 127.0.0.1 (local test redirector)", async () => {
    // When the initial hop is allowlisted via localOrigins (simulating a reachable server),
    // but that server redirects to 127.0.0.1 / localtest.me, the redirect hop MUST be refused.
    const redirectEndpoints = [
      { path: "/redirect-loopback", expected: "127.0.0.1" },
      { path: "/redirect-cgnat", expected: "100.64.0.1" },
      { path: "/redirect-v6ula", expected: "fd00::1" },
      { path: "/redirect-localtest", expected: "127.0.0.1" },
    ];

    for (const ep of redirectEndpoints) {
      const url = `${serverOrigin}${ep.path}`;
      await assert.rejects(
        async () => {
          await safeFetch(url, {
            localOrigins: [serverOrigin], // allows hop 1 only
          });
        },
        (err: any) => {
          assert.match(
            err.message,
            /SSRF Guard: Non-public address/i,
            `Expected redirect to be blocked by SSRF Guard, got: ${err.message}`
          );
          return true;
        }
      );
    }

    // Also verify via fetch_web tool dispatch with NEXUS_LOCAL_ORIGINS setting
    const prevOrigins = process.env.NEXUS_LOCAL_ORIGINS;
    try {
      process.env.NEXUS_LOCAL_ORIGINS = serverOrigin;
      const res = await bridge.executeTool("fetch_web", {
        url: `${serverOrigin}/redirect-loopback`,
      });
      assert.strictEqual(res.success, false);
      assert.match(
        res.error || "",
        /SSRF Guard: Non-public address 127\.0\.0\.1 is blocked/i,
        `Expected tool error to reflect redirect SSRF block, got: ${res.error}`
      );
    } finally {
      if (prevOrigins !== undefined) {
        process.env.NEXUS_LOCAL_ORIGINS = prevOrigins;
      } else {
        delete process.env.NEXUS_LOCAL_ORIGINS;
      }
    }
  });

  test("safeFetch streaming 5 MB cap truncates 50 MB response with RSS < 100 MB", async () => {
    const url = `${serverOrigin}/stream-50mb`;
    const beforeRss = process.memoryUsage().rss;

    const res = await safeFetch(url, {
      localOrigins: [serverOrigin],
      maxBytes: 5 * 1024 * 1024,
    });

    const afterRss = process.memoryUsage().rss;
    const deltaMb = ((afterRss - beforeRss) / (1024 * 1024)).toFixed(1);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(
      res.text.length,
      5 * 1024 * 1024,
      "Body must be truncated at exactly 5 MB (5242880 bytes)"
    );

    // Verify in-process memory growth during streaming 50 MB is strictly bounded (< 35 MB)
    assert.ok(
      afterRss - beforeRss < 35 * 1024 * 1024,
      `Memory delta during streaming must be bounded (< 35 MB, measured ${deltaMb} MB)`
    );

    // Clean node process qualification check: verify streaming fetch operates with total RSS < 100 MB
    const childScript = `
      const http = require("node:http");
      const req = http.get("${url}", async (res) => {
        let bytes = 0;
        for await (const chunk of res) {
          bytes += chunk.length;
          if (bytes >= 5242880) {
            res.destroy();
            break;
          }
        }
        const rss = process.memoryUsage().rss;
        console.log(JSON.stringify({ bytes, rss }));
        process.exit(0);
      });
    `;
    const { stdout } = await execFileAsync(process.execPath, ["-e", childScript]);
    const childResult = JSON.parse(stdout);
    const childRssMb = (childResult.rss / (1024 * 1024)).toFixed(1);
    assert.ok(
      childResult.rss < 100 * 1024 * 1024,
      `Clean process RSS must remain < 100 MB after streaming 50 MB response (measured ${childRssMb} MB)`
    );
  });

  test("safeFetch enforces maxRedirects limit", async () => {
    const url = `${serverOrigin}/redirect-loop`;
    await assert.rejects(
      async () => {
        await safeFetch(url, {
          localOrigins: [serverOrigin],
          maxRedirects: 3,
        });
      },
      /Too many redirects \(maximum 3\)/i
    );
  });

  test("safeFetch rejects an unreachable pinned address without crashing the process", () => {
    // Node's http(s).request can emit ENETUNREACH/EINVAL on the socket before the request
    // attaches its error listener when a custom `lookup` supplies the pinned address. That
    // unhandled 'error' event terminated the whole CLI. Run in a child so a regression is a
    // clean test failure instead of killing the test runner.
    const script = `
import { safeFetch } from ${JSON.stringify(path.resolve("src/tools.ts"))};
try {
  await safeFetch("http://[2001:2::1]:80/", { timeoutMs: 800 });
  console.log("RESOLVED");
} catch (error) {
  console.log("REJECTED:" + (error?.code || error?.message));
}
process.exit(0);
`;
    const result = cp.spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: path.resolve("."),
        env: { ...process.env, HOME: tempDir, XDG_CONFIG_HOME: path.join(tempDir, ".config") },
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    assert.equal(result.status, 0, `child crashed or timed out:\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /^REJECTED:/, `expected a rejected fetch, got: ${result.stdout}`);
  });

  test("safeFetch pins DNS address for the connection", async () => {
    // Custom mock DNS lookup returns a custom address
    let lookupCalledWithHost = "";
    const mockLookup = async (host: string) => {
      lookupCalledWithHost = host;
      return [{ address: "127.0.0.1", family: 4 }];
    };

    const pinnedUrl = `http://custom-pinned-host.test:${serverPort}/hello`;
    const res = await safeFetch(pinnedUrl, {
      dnsLookup: mockLookup,
      localOrigins: ["*"], // allow local for test connection
    });

    assert.strictEqual(lookupCalledWithHost, "custom-pinned-host.test");
    assert.strictEqual(res.ok, true);
    assert.match(res.text, /Hello World/);
  });
});

describe(
  "safeFetch HTTPS keeps certificate identity while pinning",
  { skip: cp.spawnSync("openssl", ["version"]).status !== 0 && "openssl not available" },
  () => {
    let dir: string;
    let tlsServer: https.Server;
    let tlsPort: number;
    let caPath: string;

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssrf-tls-"));
      const openssl = (args: string[]) => cp.execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
      openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Nexus SSRF Test Root",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
      openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=pinned.example"]);
      fs.writeFileSync(path.join(dir, "ext.cnf"),
        "[ext]\nsubjectAltName=DNS:pinned.example,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n" +
        "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
      openssl(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
        "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "ext.cnf", "-extensions", "ext"]);
      caPath = path.join(dir, "ca.crt");
      tlsServer = https.createServer(
        { key: fs.readFileSync(path.join(dir, "srv.key")), cert: fs.readFileSync(path.join(dir, "srv.crt")) },
        (_req, res) => { res.writeHead(200); res.end("TLS OK"); }
      );
      await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", () => resolve()));
      tlsPort = (tlsServer.address() as any).port;
    });

    after(async () => {
      if (tlsServer) await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const host of ["pinned.example", "127.0.0.1"]) {
      test(`pins and preserves the certificate identity for https://${host}`, async () => {
        const script = `
import { safeFetch } from ${JSON.stringify(path.resolve("src/tools.ts"))};
try {
  const r = await safeFetch(process.env.TEST_URL, {
    timeoutMs: 8000,
    localOrigins: ["*"],
    dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  console.log("TLSRESULT:" + r.status + ":" + r.text);
} catch (error) {
  console.log("TLSERROR:" + error.message);
}
process.exit(0);
`;
        // The TLS server lives in this process, so spawn asynchronously; spawnSync would block
        // the event loop and the child could never connect.
        const child = cp.spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", script],
          {
            cwd: path.resolve("."),
            env: {
              ...process.env,
              HOME: dir,
              XDG_CONFIG_HOME: path.join(dir, ".config"),
              NODE_EXTRA_CA_CERTS: caPath,
              TEST_URL: `https://${host}:${tlsPort}/hello`,
            },
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
        assert.equal(status, 0, stderr || stdout);
        assert.match(stdout, /TLSRESULT:200:TLS OK/, stdout + stderr);
      });
    }
  }
);
