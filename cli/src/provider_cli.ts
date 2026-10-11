/**
 * Operator surface for cloud providers: what is configured, which credentials are present (never their values),
 * where each role's requests go, and an opt-in live check that a provider/model completes a tool round trip.
 */
import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { InferenceError, LocalLlmClient, operatorSetting } from "./client.js";
import { buildConfig } from "./config.js";
import { baseUrlSetting, disclosureClass, originOf, PROVIDERS } from "./providers.js";
import type { ChatMessage, HarnessConfig, ToolDefinition } from "./types.js";
import { UsageLedger } from "./usage.js";
import { resolveCredential } from "./credentials.js";
import { connectWithKey, disconnect, startSignIn } from "./provider_connect.js";

/** One line naming each role's selected destination and its disclosure class. */
export function describeTarget(config: HarnessConfig): string {
  const target = (provider: string | undefined, endpoint: string, model: string) => {
    const where = provider ? `${provider} (${originOf(endpoint)})` : originOf(endpoint) ?? endpoint;
    return `${where} · ${model || "(no model)"} · ${disclosureClass(endpoint, provider, config.cloudRoutedOrigins)}`;
  };
  const parts = [`main: ${target(config.provider, config.endpoint, config.model)}`];
  if (config.plannerModel) {
    const p = config.plannerProvider ?? (config.plannerEndpoint ? undefined : config.provider);
    parts.push(`planner: ${target(p, config.plannerEndpoint ?? config.endpoint, config.plannerModel)}`);
  }
  if (config.coderModel) {
    const p = config.coderProvider ?? (config.coderEndpoint ? undefined : config.provider);
    parts.push(`coder: ${target(p, config.coderEndpoint ?? config.endpoint, config.coderModel)}`);
  }
  return `[nexus] Inference — ${parts.join(" | ")}`;
}

const ECHO_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "echo_token",
    description: "Echo the given token back. Call this exactly once with the token the user gives you.",
    parameters: { type: "object", properties: { token: { type: "string", description: "The token to echo" } }, required: ["token"] },
  },
};

export interface VerificationStep {
  step: string;
  ok: boolean;
  detail: string;
  requestId: string;
}

/**
 * Live qualification without workspace content: a streamed completion, then a tool round trip (the model must call
 * echo_token with a nonce, receive its result and answer). Each step is one receipt in the usage ledger.
 */
export async function verifyProvider(config: HarnessConfig, signal?: AbortSignal): Promise<VerificationStep[]> {
  const client = new LocalLlmClient({ ...config, maxSteps: 1 }, { role: "qualification" });
  const steps: VerificationStep[] = [];
  const run = async (step: string, fn: (requestId: string) => Promise<string>) => {
    const requestId = randomUUID();
    try {
      steps.push({ step, ok: true, detail: await fn(requestId), requestId });
    } catch (err: any) {
      const detail = err instanceof InferenceError ? `${err.kind}/${err.condition}: ${err.message}` : String(err?.message ?? err);
      steps.push({ step, ok: false, detail, requestId });
    }
  };
  await run("streamed completion", async (id) => {
    let streamed = "";
    const m = await client.chatCompletionStream([{ role: "user", content: "Reply with exactly the word READY." }], [], (t) => (streamed += t), id, signal);
    const text = typeof m.content === "string" ? m.content : "";
    if (!/READY/i.test(text)) throw new Error(`unexpected reply: ${text.slice(0, 80)}`);
    return `reply "${text.trim().slice(0, 40)}", ${streamed.length} chars streamed`;
  });
  if (!steps[0].ok) return steps;
  const nonce = `n${randomUUID().slice(0, 8)}`;
  const history: ChatMessage[] = [
    { role: "system", content: "You are a connectivity check. Use the tool when asked." },
    { role: "user", content: `Call echo_token with token "${nonce}", then tell me what it returned.` },
  ];
  let call: ChatMessage | undefined;
  await run("tool call", async (id) => {
    call = await client.chatCompletionStream(history, [ECHO_TOOL], undefined, id, signal);
    const tc = call.tool_calls?.[0];
    if (!tc || tc.function.name !== "echo_token") throw new Error("model did not call echo_token");
    const args = JSON.parse(tc.function.arguments || "{}");
    if (args.token !== nonce) throw new Error(`tool arguments did not carry the nonce: ${tc.function.arguments.slice(0, 80)}`);
    return `echo_token(${tc.function.arguments}) complete, ${call.tool_calls!.length} call(s)`;
  });
  if (!steps[1].ok || !call) return steps;
  await run("tool result round trip", async (id) => {
    const tc = call!.tool_calls![0];
    const followUp: ChatMessage[] = [
      ...history,
      { role: "assistant", content: call!.content ?? null, tool_calls: call!.tool_calls, ...(call!.provider_state ? { provider_state: call!.provider_state } : {}) },
      ...call!.tool_calls!.map((c) => ({ role: "tool" as const, tool_call_id: c.id, name: c.function.name, content: c.id === tc.id ? `echoed:${nonce}` : "skipped" })),
    ];
    const final = await client.chatCompletionStream(followUp, [ECHO_TOOL], undefined, id, signal);
    const text = typeof final.content === "string" ? final.content : "";
    if (!text.includes(nonce)) throw new Error(`final answer did not use the tool result: ${text.slice(0, 80)}`);
    return `final answer cites the tool result`;
  });
  return steps;
}

/** Reads a secret: piped stdin as-is, or typed at the terminal without echo. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  (rl as any)._writeToOutput = (text: string) => { if (!muted || text.includes("\n")) process.stdout.write(muted ? "\n" : text); };
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
    muted = true;
  });
}

export function registerProviderCommands(program: Command): void {
  program
    .command("connect")
    .description("Connect a cloud provider: save an API key (verified first) or sign in")
    .argument("<provider>", "openrouter, openai, anthropic, chatgpt, copilot, compatible")
    .option("--method <id>", "api-key (default where offered), openrouter-oauth, chatgpt-oauth, copilot-device")
    .action(async (providerId: string, options: any) => {
      const def = PROVIDERS[providerId];
      if (!def) {
        console.error(pc.red(`Unknown provider '${providerId}'. Known: ${Object.keys(PROVIDERS).join(", ")}`));
        process.exit(2);
      }
      const method = def.methods.find((m) => m.id === (options.method ?? def.methods[0].id));
      if (!method) {
        console.error(pc.red(`${def.label} methods: ${def.methods.map((m) => m.id).join(", ")}`));
        process.exit(2);
      }
      const base = buildConfig({});
      const existing = resolveCredential(def.id, def.credentialEnv);
      if (existing) console.log(pc.dim(`${def.label} is already connected via ${existing.source}; a new connection is saved in Nexus.`));
      if (method.unofficial) console.log(pc.yellow(`${method.label}: unofficial — it signs in as another vendor's client, which the provider's terms may not permit.`));
      if (method.kind === "key") {
        const r = await connectWithKey(base, def.id, await readSecret(`${def.label} API key: `));
        console.log(r.ok ? pc.green(r.message) : pc.red(r.message));
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      const signIn = await startSignIn(base, def.id, method.id);
      process.once("SIGINT", () => signIn.cancel());
      console.log(`\n${signIn.prompt.instructions}\n  ${pc.bold(signIn.prompt.url)}${signIn.prompt.userCode ? `\n  code: ${pc.bold(signIn.prompt.userCode)}` : ""}\n`);
      const r = await signIn.done;
      console.log(r.ok ? pc.green(r.message) : pc.red(r.message));
      process.exitCode = r.ok ? 0 : 1;
    });

  program
    .command("disconnect")
    .description("Remove the credential Nexus saved for a provider (environment and other clients are untouched)")
    .argument("<provider>")
    .action((providerId: string) => {
      const r = disconnect(providerId);
      console.log(r.ok ? pc.green(r.message) : pc.yellow(r.message));
    });

  const providers = program
    .command("providers")
    .description("List cloud inference providers, credential status and the selected destinations")
    .action(() => {
      console.log(pc.bold("\nCloud inference providers\n"));
      for (const def of Object.values(PROVIDERS)) {
        const base = operatorSetting(baseUrlSetting(def.id)) || def.baseUrl || "(set --base-url or " + baseUrlSetting(def.id) + ")";
        const found = resolveCredential(def.id, def.credentialEnv);
        const key = found ? pc.green(`connected via ${found.source}`) : pc.yellow(`not connected (${def.credentialEnv ? `$${def.credentialEnv} or ` : ""}nexus connect ${def.id})`);
        console.log(`  ${pc.bold(def.id.padEnd(11))} ${def.protocol.padEnd(19)} ${base}`);
        console.log(`  ${"".padEnd(11)} ${key}${def.methods.some((m) => m.unofficial) ? pc.dim("  · unofficial sign-in") : ""}`);
      }
      let config: HarnessConfig;
      try {
        config = buildConfig({});
      } catch (err: any) {
        console.log(pc.red(`\nConfiguration error: ${err?.message ?? err}`));
        process.exitCode = 2;
        return;
      }
      console.log(`\n${describeTarget(config)}`);
      const authorized = config.authorizedDisclosureOrigins ?? [];
      console.log(pc.dim(`Authorized cloud destinations: ${authorized.length ? authorized.join(", ") : "none"}`));
      console.log(pc.dim("Select with --provider <id> --model <id> (or NEXUS_PROVIDER / NEXUS_MODEL in ~/.config/nexus/config.env).\n"));
    });

  providers
    .command("verify")
    .description("Live check: streamed completion and a tool round trip against a provider (sends no workspace content)")
    .requiredOption("--provider <id>", "Provider to check")
    .option("-m, --model <name>", "Model id (default: $NEXUS_MODEL)")
    .option("--base-url <url>", "Override the provider's base URL")
    .option("-j, --json", "Print steps and receipts as JSON")
    .action(async (options: any) => {
      let config: HarnessConfig;
      try {
        config = buildConfig(options);
      } catch (err: any) {
        console.error(pc.red(`Configuration error: ${err?.message ?? err}`));
        process.exit(2);
      }
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort(new Error("SIGINT")));
      const steps = await verifyProvider(config, abort.signal);
      const receipts = UsageLedger.global().all();
      const passed = steps.length === 3 && steps.every((s) => s.ok);
      if (options.json) {
        console.log(JSON.stringify({ provider: config.provider, model: config.model, date: new Date().toISOString(), passed, steps, receipts }, null, 2));
      } else {
        console.log(pc.bold(`\nLive check: ${config.provider} · ${config.model}`));
        for (const s of steps) console.log(`  ${s.ok ? pc.green("✓") : pc.red("✗")} ${s.step}: ${s.detail}`);
        const summary = UsageLedger.global().summary();
        if (summary) console.log(pc.dim(summary));
        console.log(passed ? pc.green("\nInference verified (completion + tool round trip).\n") : pc.red("\nNot verified.\n"));
      }
      process.exitCode = passed ? 0 : 1;
    });
}
