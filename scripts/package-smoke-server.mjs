import http from "node:http";

const server = http.createServer((request, response) => {
  if (request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "package-smoke" }] }));
    return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "NEXUS_PACKAGE_SMOKE_OK" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
