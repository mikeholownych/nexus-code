#!/usr/bin/env node
// Standalone qualification (DEC-16, ACCEPTANCE §4): serve the gateway to Nexus as a plain OpenAI-compatible server,
// optionally shaped like llama.cpp, vLLM or Ollama. The gateway token stays here; point Nexus's clean HOME at the URL
// printed below with LOCAL_LLM_API_KEY=local.
// usage: eval/standalone/plain_proxy.mjs --upstream https://gateway:8443/v1 --token-file FILE [--ca-file FILE]
//        [--emulate plain|llamacpp|vllm|ollama]
import fs from "node:fs";
import { startModelProxy } from "../model_proxy.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]] : acc), []));
if (!args.upstream) {
  console.error("usage: plain_proxy.mjs --upstream URL [--token-file FILE] [--ca-file FILE] [--emulate plain|llamacpp|vllm|ollama]");
  process.exit(2);
}
const authToken = args["token-file"] ? fs.readFileSync(args["token-file"], "utf8").trim() : undefined;
const proxy = await startModelProxy({ upstream: args.upstream, caFile: args["ca-file"], profile: args.emulate ?? "plain", authToken });
console.log(`${proxy.url}  (profile ${args.emulate ?? "plain"}; gateway extensions removed)`);
process.on("SIGINT", async () => { await proxy.close(); process.exit(0); });
