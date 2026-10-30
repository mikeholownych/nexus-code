#!/usr/bin/env node
// Serves one published release directory to the guest over QEMU slirp
// (guest reaches the host as 10.0.2.2). Usage: serve-release.cjs <dir> <port>
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
const port = Number(process.argv[3] || 18080);
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: serve-release.cjs <release-dir> [port]");
  process.exit(2);
}
const compat = JSON.parse(fs.readFileSync(path.join(dir, "compatibility.json"), "utf8"));
const tag = compat.version.startsWith("v") ? compat.version : `v${compat.version}`;
const archive = `nexus-linux-x86_64-${tag}.tar.gz`;
const names = [archive, "SHA256SUMS", "compatibility.json"];
for (const name of names) {
  if (!fs.existsSync(path.join(dir, name))) {
    console.error(`missing ${name} in ${dir}`);
    process.exit(2);
  }
}
const api = {
  tag_name: tag,
  name: `fixture ${tag}`,
  draft: false,
  prerelease: true,
  published_at: compat.builtAt || "2026-01-01T00:00:00Z",
  html_url: `http://10.0.2.2:${port}`,
  assets: names.map((name) => ({
    name,
    browser_download_url: `http://10.0.2.2:${port}/download/${tag}/${name}`,
    size: fs.statSync(path.join(dir, name)).size,
  })),
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400).end(); return; }
  const apiPrefix = `/api/releases/tags/${tag}`;
  if (pathname === apiPrefix || pathname === `${apiPrefix}/`) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(api));
    return;
  }
  const prefix = `/download/${tag}/`;
  if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
  const name = path.basename(pathname.slice(prefix.length));
  if (!names.includes(name)) { res.writeHead(404).end(); return; }
  const file = path.join(dir, name);
  res.writeHead(200, { "content-length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${tag} from ${dir} port=${server.address().port}`);
});
