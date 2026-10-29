const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = '/tmp/incompat-fixture';
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  const port = server.address().port;
  if (pathname === '/api/releases/tags/v1.0.0-rc.4' || pathname === '/api/releases/tags/v1.0.0-rc.4/') {
    const body = fs.readFileSync(path.join(root, 'api.json'), 'utf8').replaceAll('PORT', String(port));
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  const prefix = '/download/v1.0.0-rc.4/';
  if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
  const name = path.basename(pathname.slice(prefix.length));
  const file = path.join(root, 'download/v1.0.0-rc.4', name);
  if (!file.startsWith(path.join(root, 'download/v1.0.0-rc.4') + path.sep)) { res.writeHead(403).end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.writeHead(404).end());
  stream.on('open', () => res.writeHead(200));
  stream.pipe(res);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('/tmp/incompat-port', String(server.address().port)));
