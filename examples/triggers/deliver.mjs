// Sends one signed webhook delivery: node deliver.mjs <url> [body]. The secret is read from NEXUS_TRIGGER_EXAMPLE_HOOK.
// The signature is HMAC-SHA256 over `nexus-webhook-v1\n<route path>\n<timestamp>\n<delivery id>\n<body length>\n<raw body>`; see docs/TRIGGERS.md.
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const [url, body = "{}"] = process.argv.slice(2);
const secret = process.env.NEXUS_TRIGGER_EXAMPLE_HOOK;
if (!url || !secret) {
  console.error("usage: NEXUS_TRIGGER_EXAMPLE_HOOK=... node deliver.mjs <url> [body]");
  process.exit(2);
}
const timestamp = String(Math.floor(Date.now() / 1000));
const delivery = `ex-${randomBytes(8).toString("hex")}`;
const target = new URL(url);
const raw = Buffer.from(body);
const signature = createHmac("sha256", secret).update(`nexus-webhook-v1\n${target.pathname}\n${timestamp}\n${delivery}\n${raw.length}\n`).update(raw).digest("hex");
const request = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: {
  "content-type": "application/json", "content-length": raw.length,
  "x-nexus-timestamp": timestamp, "x-nexus-delivery": delivery, "x-nexus-signature": `v1=${signature}`,
} }, (response) => {
  let text = "";
  response.on("data", (chunk) => (text += chunk));
  response.on("end", () => {
    console.log(`${response.statusCode} ${text}`);
    process.exit(response.statusCode === 202 ? 0 : 1);
  });
});
request.on("error", (error) => { console.error(error.message); process.exit(1); });
request.end(raw);
