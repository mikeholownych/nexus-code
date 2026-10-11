import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { InferenceError, LocalLlmClient, operatorSetting } from "./client.js";
import { buildConfig } from "./config.js";
import { baseUrlSetting, disclosureClass, originOf, PROVIDERS } from "./providers.js";
import { UsageLedger } from "./usage.js";
/** One line naming each role's selected destination and its disclosure class. */
export function describeTarget(config) {
    const target = (provider, endpoint, model) => {
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
const ECHO_TOOL = {
    type: "function",
    function: {
        name: "echo_token",
        description: "Echo the given token back. Call this exactly once with the token the user gives you.",
        parameters: { type: "object", properties: { token: { type: "string", description: "The token to echo" } }, required: ["token"] },
    },
};
/**
 * Live qualification without workspace content: a streamed completion, then a tool round trip (the model must call
 * echo_token with a nonce, receive its result and answer). Each step is one receipt in the usage ledger.
 */
export async function verifyProvider(config, signal) {
    const client = new LocalLlmClient({ ...config, maxSteps: 1 }, { role: "qualification" });
    const steps = [];
    const run = async (step, fn) => {
        const requestId = randomUUID();
        try {
            steps.push({ step, ok: true, detail: await fn(requestId), requestId });
        }
        catch (err) {
            const detail = err instanceof InferenceError ? `${err.kind}/${err.condition}: ${err.message}` : String(err?.message ?? err);
            steps.push({ step, ok: false, detail, requestId });
        }
    };
    await run("streamed completion", async (id) => {
        let streamed = "";
        const m = await client.chatCompletionStream([{ role: "user", content: "Reply with exactly the word READY." }], [], (t) => (streamed += t), id, signal);
        const text = typeof m.content === "string" ? m.content : "";
        if (!/READY/i.test(text))
            throw new Error(`unexpected reply: ${text.slice(0, 80)}`);
        return `reply "${text.trim().slice(0, 40)}", ${streamed.length} chars streamed`;
    });
    if (!steps[0].ok)
        return steps;
    const nonce = `n${randomUUID().slice(0, 8)}`;
    const history = [
        { role: "system", content: "You are a connectivity check. Use the tool when asked." },
        { role: "user", content: `Call echo_token with token "${nonce}", then tell me what it returned.` },
    ];
    let call;
    await run("tool call", async (id) => {
        call = await client.chatCompletionStream(history, [ECHO_TOOL], undefined, id, signal);
        const tc = call.tool_calls?.[0];
        if (!tc || tc.function.name !== "echo_token")
            throw new Error("model did not call echo_token");
        const args = JSON.parse(tc.function.arguments || "{}");
        if (args.token !== nonce)
            throw new Error(`tool arguments did not carry the nonce: ${tc.function.arguments.slice(0, 80)}`);
        return `echo_token(${tc.function.arguments}) complete, ${call.tool_calls.length} call(s)`;
    });
    if (!steps[1].ok || !call)
        return steps;
    await run("tool result round trip", async (id) => {
        const tc = call.tool_calls[0];
        const followUp = [
            ...history,
            { role: "assistant", content: call.content ?? null, tool_calls: call.tool_calls, ...(call.provider_state ? { provider_state: call.provider_state } : {}) },
            ...call.tool_calls.map((c) => ({ role: "tool", tool_call_id: c.id, name: c.function.name, content: c.id === tc.id ? `echoed:${nonce}` : "skipped" })),
        ];
        const final = await client.chatCompletionStream(followUp, [ECHO_TOOL], undefined, id, signal);
        const text = typeof final.content === "string" ? final.content : "";
        if (!text.includes(nonce))
            throw new Error(`final answer did not use the tool result: ${text.slice(0, 80)}`);
        return `final answer cites the tool result`;
    });
    return steps;
}
export function registerProviderCommands(program) {
    const providers = program
        .command("providers")
        .description("List cloud inference providers, credential status and the selected destinations")
        .action(() => {
        console.log(pc.bold("\nCloud inference providers\n"));
        for (const def of Object.values(PROVIDERS)) {
            const base = operatorSetting(baseUrlSetting(def.id)) || def.baseUrl || "(set --base-url or " + baseUrlSetting(def.id) + ")";
            const key = process.env[def.credentialEnv]?.trim() ? pc.green("credential set") : pc.yellow("credential not set");
            console.log(`  ${pc.bold(def.id.padEnd(11))} ${def.protocol.padEnd(19)} ${base}`);
            console.log(pc.dim(`  ${"".padEnd(11)} ${def.credentialEnv}: `) + key);
        }
        let config;
        try {
            config = buildConfig({});
        }
        catch (err) {
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
        .action(async (options) => {
        let config;
        try {
            config = buildConfig(options);
        }
        catch (err) {
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
        }
        else {
            console.log(pc.bold(`\nLive check: ${config.provider} · ${config.model}`));
            for (const s of steps)
                console.log(`  ${s.ok ? pc.green("✓") : pc.red("✗")} ${s.step}: ${s.detail}`);
            const summary = UsageLedger.global().summary();
            if (summary)
                console.log(pc.dim(summary));
            console.log(passed ? pc.green("\nInference verified (completion + tool round trip).\n") : pc.red("\nNot verified.\n"));
        }
        process.exitCode = passed ? 0 : 1;
    });
}
