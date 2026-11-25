// Sends one signed webhook delivery: node deliver.mjs <url> [body]. The secret is read from NEXUS_EXAMPLE_HOOK_SECRET.
// The signature is HMAC-SHA256 over `<timestamp>.<delivery id>.<raw body>`; see docs/TRIGGERS.md.
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const [url, body = "{}"] = process.argv.slice(2);
const secret = process.env.NEXUS_EXAMPLE_HOOK_SECRET;
if (!url || !secret) {
  console.error("usage: NEXUS_EXAMPLE_HOOK_SECRET=... node deliver.mjs <url> [body]");
  process.exit(2);
}
const timestamp = String(Math.floor(Date.now() / 1000));
const delivery = `ex-${randomBytes(8).toString("hex")}`;
const signature = createHmac("sha256", secret).update(`${timestamp}.${delivery}.`).update(body).digest("hex");
const target = new URL(url);
const request = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: {
  "content-type": "application/json", "content-length": Buffer.byteLength(body),
  "x-nexus-timestamp": timestamp, "x-nexus-delivery": delivery, "x-nexus-signature": `sha256=${signature}`,
} }, (response) => {
  let text = "";
  response.on("data", (chunk) => (text += chunk));
  response.on("end", () => {
    console.log(`${response.statusCode} ${text}`);
    process.exit(response.statusCode === 202 ? 0 : 1);
  });
});
request.on("error", (error) => { console.error(error.message); process.exit(1); });
request.end(body);
