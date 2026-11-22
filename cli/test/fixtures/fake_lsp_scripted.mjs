// Scripted stdio language server for characterisation tests. Usage: node fake_lsp_scripted.mjs <scenario.json>
// It does nothing by itself except answer `initialize`, `shutdown`/`exit` and every other request with `null`;
// everything else is driven by the scenario. The existing fake_lsp_server.mjs is separate and unchanged.
//
// Scenario (JSON object; every key but `log` is optional):
//   log              path of a JSON-lines file; one entry per event, appended synchronously, in order:
//                      {event:"start", pid}                      this process
//                      {event:"grandchild", pid}                 the process started by `spawnGrandchild`
//                      {event:"recv", method, id?, params, docs} every request and notification received; `docs` is the
//                                                                text this server holds per URI AFTER applying the message
//                                                                (didOpen / didChange full text / didClose)
//                      {event:"reply", to, id, result?, error?}  the client's answer to a server request (`to` = its method)
//                      {event:"answer", to, result?, error?}     this server's answer to `textDocument/diagnostic`
//                      {event:"signal", signal}                  a signal caught because of `ignoreSigterm`
//                    A `text` longer than 2000 characters is logged as {elidedChars: n}.
//   stderrOnStart    text written to stderr at start
//   exitOnStart      exit code: exit at once (after stderrOnStart), before reading anything
//   spawnGrandchild  true: start a child process that idles (it ends by itself after 60 s) and log its pid
//   ignoreSigterm    true: catch SIGTERM and keep running
//   ignoreShutdown   true: never answer `shutdown`, ignore `exit`
//   initialize       "never" (no answer), or the result object (default {capabilities: {}})
//   hover            "fromText": answer from the held text with contents = JSON {word, docs} where `word` is the
//                    identifier at the position (character read as a UTF-16 offset) and `docs` maps basename -> held text;
//                    or {"<basename>" | "*": <result>}: a scripted result per file (null = no hover, "never" = no reply)
//   definition       "fromText": the Location of the first `def <word>` in any held document, else null;
//                    or {"<basename>" | "*": <result>} ("never" = no reply)
//   loadedOn         a method ("test/release"): until it is received, hover and definition answer null, as a server
//                    that has not loaded the project yet does
//   diagnostic       how `textDocument/diagnostic` is answered (announce `diagnosticProvider` through `initialize`):
//                    "fromText": a full report with one item whose message names the file and the text held for every
//                    document (so a file's report depends on the others), with that message as resultId; or
//                    {kind: "unchanged"} when the request's previousResultId equals it;
//                    or a list of answers used in order, the last one repeating: {result}, {error} or "never"
//   on               {"<trigger>": [action, ...]} where trigger is a received method ("initialized", "test/release"), or
//                    "<method>#<basename>" for one file ("textDocument/didOpen#a.ts"). Actions run before the reply.
//   action           {after?: ms, request?: true, method, params}: send a notification, or with `request` a server
//                    request whose reply is logged. Without `after` it is sent synchronously, in order.
// In action params and scripted results a string is replaced when it is exactly "$uri" (the triggering document's URI),
// "$realuri" (the same file with symlinks resolved), "$uri:lowerhex" (the same URI with lower-case percent escapes),
// "$uri:unicode" (the same URI with its non-ASCII characters not percent-encoded), "$version" (its version, as a number),
// "$text" (the text this server holds for it; "" once closed), or starts with "$root/" (the client's rootUri; also in object keys).
// The server exits when its stdin ends, so it cannot outlive a test process that died.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const S = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const elide = (_k, v) => (_k === "text" && typeof v === "string" && v.length > 2000 ? { elidedChars: v.length } : v);
const log = (entry) => fs.appendFileSync(S.log, `${JSON.stringify(entry, elide)}\n`);
const docs = new Map(); // uri -> text
const sent = new Map(); // server request id -> method
let loaded = !S.loadedOn;
let rootUri = "";
let nextId = 1;
let buf = Buffer.alloc(0);

log({ event: "start", pid: process.pid });
if (S.stderrOnStart) fs.writeSync(2, S.stderrOnStart);
if (S.spawnGrandchild) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  child.unref();
  log({ event: "grandchild", pid: child.pid });
}
if (S.ignoreSigterm) process.on("SIGTERM", () => log({ event: "signal", signal: "SIGTERM" }));
if (typeof S.exitOnStart === "number") process.exit(S.exitOnStart);

function send(msg) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function fill(value, ctx) {
  if (typeof value === "string") {
    if (value === "$uri") return ctx.uri;
    if (value === "$realuri") return pathToFileURL(fs.realpathSync(fileURLToPath(ctx.uri))).href;
    if (value === "$uri:lowerhex") return ctx.uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    if (value === "$uri:unicode") return ctx.uri.replace(/(?:%[89A-F][0-9A-F])+/g, (escapes) => decodeURIComponent(escapes));
    if (value === "$version") return ctx.version;
    if (value === "$text") return docs.get(ctx.uri) ?? "";
    return value.startsWith("$root/") ? rootUri + value.slice(5) : value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.startsWith("$root/") ? rootUri + k.slice(5) : k, fill(v, ctx)]));
  return value;
}

function act(action, ctx) {
  const msg = { method: action.method, params: fill(action.params, ctx) };
  if (action.request) {
    msg.id = `s${nextId++}`;
    sent.set(msg.id, action.method);
  }
  send(msg);
}

function run(trigger, ctx) {
  for (const action of S.on?.[trigger] ?? []) {
    if (action.after) setTimeout(() => act(action, ctx), action.after);
    else act(action, ctx);
  }
}

const base = (uri) => path.basename(fileURLToPath(uri));

function wordAt(uri, position) {
  const line = (docs.get(uri) ?? "").split("\n")[position?.line] ?? "";
  const isWord = (i) => /[A-Za-z0-9_]/.test(line[i] ?? "");
  let start = position?.character;
  if (!isWord(start)) return "";
  let end = start;
  while (isWord(start - 1)) start--;
  while (isWord(end + 1)) end++;
  return line.slice(start, end + 1);
}

function answer(script, m, fromText) {
  const uri = m.params.textDocument.uri;
  if (!loaded) return null;
  if (script === "fromText") return fromText(uri, wordAt(uri, m.params.position));
  const scripted = script?.[base(uri)] ?? script?.["*"] ?? null;
  return fill(scripted, { uri });
}

function hoverFromText(_uri, word) {
  return { contents: JSON.stringify({ word, docs: Object.fromEntries([...docs].map(([u, text]) => [base(u), text])) }) };
}

function definitionFromText(_uri, word) {
  for (const [uri, text] of docs) {
    const lines = text.split("\n");
    const line = lines.findIndex((l) => word !== "" && l.includes(`def ${word}`));
    if (line < 0) continue;
    const character = lines[line].indexOf(`def ${word}`) + 4;
    return { uri, range: { start: { line, character }, end: { line, character: character + word.length } } };
  }
  return null;
}

let pulls = 0;
function diagnosticAnswer(m) {
  const uri = m.params.textDocument.uri;
  if (S.diagnostic !== "fromText") return S.diagnostic?.[Math.min(pulls++, S.diagnostic.length - 1)] ?? { result: null };
  const message = `${base(uri)} with ${[...docs].map(([u, text]) => `${base(u)}=${text}`).sort().join(" ")}`;
  if (m.params.previousResultId === message) return { result: { kind: "unchanged", resultId: message } };
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  return { result: { kind: "full", resultId: message, items: [{ range, severity: 1, message, source: "fake" }] } };
}

function handle(m) {
  if (m.method === undefined) {
    log({ event: "reply", to: sent.get(m.id), id: m.id, ...("result" in m ? { result: m.result } : {}), ...(m.error ? { error: m.error } : {}) });
    return;
  }
  const doc = m.params?.textDocument;
  if (m.method === "initialize") rootUri = m.params.rootUri;
  if (m.method === S.loadedOn) loaded = true;
  if (m.method === "textDocument/didOpen") docs.set(doc.uri, doc.text);
  if (m.method === "textDocument/didChange") docs.set(doc.uri, m.params.contentChanges.at(-1).text);
  if (m.method === "textDocument/didClose") docs.delete(doc.uri);
  log({ event: "recv", method: m.method, ...(m.id !== undefined ? { id: m.id } : {}), params: m.params, docs: Object.fromEntries([...docs].map(([u, text]) => [u, elide("text", text)])) });

  const ctx = { uri: doc?.uri, version: doc?.version };
  run(m.method, ctx);
  if (doc?.uri) run(`${m.method}#${base(doc.uri)}`, ctx);

  if (m.method === "exit") {
    if (!S.ignoreShutdown) process.exit(0);
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    if (S.initialize !== "never") send({ id: m.id, result: S.initialize ?? { capabilities: {} } });
  } else if (m.method === "shutdown") {
    if (!S.ignoreShutdown) send({ id: m.id, result: null });
  } else if (m.method === "textDocument/hover" || m.method === "textDocument/definition") {
    const result = m.method === "textDocument/hover" ? answer(S.hover, m, hoverFromText) : answer(S.definition, m, definitionFromText);
    if (result !== "never") send({ id: m.id, result });
  }
  else if (m.method === "textDocument/diagnostic") {
    const scripted = diagnosticAnswer(m);
    if (scripted === "never") return;
    const reply = scripted.error ? { error: scripted.error } : { result: fill(scripted.result, ctx) };
    log({ event: "answer", to: m.method, ...reply });
    send({ id: m.id, ...reply });
  }
  else send({ id: m.id, result: null });
}

process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString())[1]);
    if (buf.length < headerEnd + 4 + length) return;
    const body = buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
    buf = buf.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
