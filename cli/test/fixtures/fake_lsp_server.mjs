// Minimal stdio LSP server for tests. Publishes one error for every opened document whose text contains "BAD".
// A document opened without "BAD" gets an empty diagnostics list. Files named *.silent.ts never publish.
let buf = Buffer.alloc(0);
function send(msg) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function publish(uri, text) {
  if (uri.endsWith(".silent.ts")) return;
  const diagnostics = text.includes("BAD")
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "type error", source: "fake" }]
    : [];
  send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
}
function handle(m) {
  if (m.method === "initialize") send({ id: m.id, result: { capabilities: {} } });
  else if (m.method === "shutdown") send({ id: m.id, result: null });
  else if (m.method === "exit") process.exit(0);
  else if (m.method === "textDocument/didOpen") publish(m.params.textDocument.uri, m.params.textDocument.text);
  else if (m.method === "textDocument/didChange") publish(m.params.textDocument.uri, m.params.contentChanges[0].text);
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
