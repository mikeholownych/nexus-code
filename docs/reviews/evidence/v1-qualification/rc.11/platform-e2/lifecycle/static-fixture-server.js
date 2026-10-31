const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = '/tmp/release-fixture';
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { res.writeHead(404).end(); });
  stream.on('open', () => res.writeHead(200));
  stream.pipe(res);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('/tmp/fixture-port', String(server.address().port)));
