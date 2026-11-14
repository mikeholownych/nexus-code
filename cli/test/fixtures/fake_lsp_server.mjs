// Minimal stdio LSP server for tests. Publishes one error for every opened document whose text contains "BAD".
// A document opened without "BAD" gets an empty diagnostics list. Files named *.silent.ts never publish.
let buf = Buffer.alloc(0);
function send(msg) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
if (process.env.FAKE_PIDFILE) require_fs().appendFileSync(process.env.FAKE_PIDFILE, process.pid + "\n");
function require_fs() { return globalThis.__fs ??= process.getBuiltinModule("node:fs"); }
if (process.env.FAKE_ENVFILE) require_fs().writeFileSync(process.env.FAKE_ENVFILE, JSON.stringify(process.env));
function publish(uri, text, version) {
  if (uri.endsWith(".noisy.ts")) for (let i = 0; i < 64; i++) require_fs().writeSync(2, "x".repeat(65536));
  if (uri.endsWith(".utf.ts")) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "h\u00e9llo \u20ac \ud83d\ude00 \u00fc\u00f1", source: "fake" }] } }));
    const all = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    for (let i = 0; i * 3 < all.length; i++) setTimeout(() => process.stdout.write(all.subarray(i * 3, i * 3 + 3)), i);
    return;
  }
  if (uri.endsWith(".near.ts") || uri.endsWith(".over.ts")) {
    const filler = "a".repeat(uri.endsWith(".near.ts") ? 16 * 1024 * 1024 - 1024 : 17 * 1024 * 1024);
    if (uri.endsWith(".over.ts")) { process.stdout.write(filler); return; }
    const body = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: filler, source: "fake" }] } });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return;
  }
  if (uri.endsWith(".huge.ts")) { process.stdout.write("Content-Length: 99999999\r\n\r\n" + "x".repeat(1024)); return; }
  if (uri.endsWith(".silent.ts")) return;
  if (uri.endsWith(".die.ts")) process.exit(1);
  if (text.includes("STALE")) {
    send({ method: "textDocument/publishDiagnostics", params: { uri, version: version - 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "stale", source: "fake" }] } });
    setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [] } }), 150);
    return;
  }
  const diagnostics = text.includes("BAD")
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "type error", source: "fake" }]
    : [];
  send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
}
function handle(m) {
  if (m.method === "initialize") send({ id: m.id, result: { capabilities: {} } });
  else if (m.method === "shutdown") send({ id: m.id, result: null });
  else if (m.method === "exit") process.exit(0);
  else if (m.method === "textDocument/didOpen") publish(m.params.textDocument.uri, m.params.textDocument.text, m.params.textDocument.version);
  else if (m.method === "textDocument/didChange") publish(m.params.textDocument.uri, m.params.contentChanges[0].text, m.params.textDocument.version);
  else if (m.method === "textDocument/hover") send({ id: m.id, result: { contents: "hover ok" } });
  else if (m.id !== undefined) send({ id: m.id, result: null });
}
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString())[1]);
    if (buf.length < he + 4 + len) return;
    const body = buf.slice(he + 4, he + 4 + len).toString();
    buf = buf.slice(he + 4 + len);
    handle(JSON.parse(body));
  }
});
