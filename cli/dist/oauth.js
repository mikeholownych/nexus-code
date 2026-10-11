/**
 * Sign-in flows that end in a provider credential.
 *
 * - OpenRouter: OpenRouter's documented PKCE flow for third-party apps; the result is a user API key.
 * - ChatGPT plan (UNOFFICIAL): the browser PKCE flow of OpenAI's Codex CLI, using the Codex CLI's public client id.
 *   Requests then go to the ChatGPT Codex backend. OpenAI does not offer this to third-party apps.
 * - GitHub Copilot (UNOFFICIAL): the GitHub device flow with the VS Code Copilot plugin's client id, then an
 *   exchange for a short-lived Copilot API token. GitHub does not offer this to third-party apps.
 *
 * The operator chose to ship the unofficial flows knowing the providers' terms may not permit them; the UI labels
 * them. Endpoints are injectable so tests run against local mock servers.
 */
import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { chatgptAccountId, jwtExpiry } from "./credentials.js";
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
/** Headers the Copilot API expects from an editor integration. */
export const COPILOT_HEADERS = Object.freeze({
    "User-Agent": "GitHubCopilotChat/0.32.4",
    "Editor-Version": "vscode/1.105.1",
    "Editor-Plugin-Version": "copilot-chat/0.32.4",
    "Copilot-Integration-Id": "vscode-chat",
});
export const DEFAULT_ENDPOINTS = {
    openrouterAuth: "https://openrouter.ai/auth",
    openrouterKeys: "https://openrouter.ai/api/v1/auth/keys",
    chatgptIssuer: "https://auth.openai.com",
    chatgptPorts: [1455, 1457],
    githubDeviceCode: "https://github.com/login/device/code",
    githubAccessToken: "https://github.com/login/oauth/access_token",
    copilotToken: "https://api.github.com/copilot_internal/v2/token",
    minPollMs: 5_000,
};
let endpoints = { ...DEFAULT_ENDPOINTS };
/** Tests point the flows and refreshes at local mock servers. */
export function setOAuthEndpoints(overrides) {
    endpoints = overrides ? { ...DEFAULT_ENDPOINTS, ...overrides } : { ...DEFAULT_ENDPOINTS };
}
export function oauthEndpoints() {
    return endpoints;
}
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function pkcePair() {
    const verifier = b64url(randomBytes(48));
    return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
const savedAt = () => new Date().toISOString();
const MAX_BODY = 1 << 20;
async function postForm(url, form, headers = {}, signal) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
        body: new URLSearchParams(form).toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        redirect: "error",
    });
    const text = (await res.text()).slice(0, MAX_BODY);
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    if (!res.ok)
        throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${(body?.error_description ?? body?.error ?? text).toString().slice(0, 200)}`);
    return body ?? {};
}
/**
 * One-shot loopback HTTP listener for an OAuth redirect. Resolves with the callback's query parameters; the page
 * tells the operator to return to the terminal.
 */
async function loopback(ports, callbackPath, signal) {
    let resolveParams;
    let rejectParams;
    const params = new Promise((res, rej) => { resolveParams = res; rejectParams = rej; });
    const server = http.createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://localhost");
        if (u.pathname !== callbackPath) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p>Signed in. You can close this tab and return to Nexus.</p>");
        resolveParams(u.searchParams);
    });
    let bound;
    for (const port of ports) {
        try {
            await new Promise((res, rej) => {
                server.once("error", rej);
                server.listen(port, "127.0.0.1", () => { server.off("error", rej); res(); });
            });
            bound = server.address().port;
            break;
        }
        catch {
            // try the next port
        }
    }
    if (bound === undefined)
        throw new Error(`Could not listen on localhost port ${ports.join(" or ")} for the sign-in callback (is another sign-in running?).`);
    const close = () => { server.closeAllConnections?.(); server.close(); };
    const onAbort = () => { rejectParams(new Error("Sign-in cancelled.")); close(); };
    signal.addEventListener("abort", onAbort, { once: true });
    params.finally(() => { signal.removeEventListener("abort", onAbort); close(); }).catch(() => { });
    return { redirectUri: `http://localhost:${bound}${callbackPath}`, params, close };
}
// ---------------------------------------------------------------- OpenRouter (official PKCE)
async function openrouterFlow(ep, signal) {
    const pkce = pkcePair();
    const lb = await loopback([0], "/callback", signal);
    const url = `${ep.openrouterAuth}?${new URLSearchParams({ callback_url: lb.redirectUri, code_challenge: pkce.challenge, code_challenge_method: "S256" })}`;
    const result = (async () => {
        const code = (await lb.params).get("code");
        if (!code)
            throw new Error("OpenRouter did not return an authorization code.");
        const res = await fetch(ep.openrouterKeys, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, code_verifier: pkce.verifier, code_challenge_method: "S256" }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            redirect: "error",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.key !== "string")
            throw new Error(`OpenRouter key exchange failed (HTTP ${res.status}).`);
        return { type: "api", key: body.key, label: "OpenRouter sign-in", savedAt: savedAt() };
    })();
    return { prompt: { url, instructions: "Approve Nexus in the browser; OpenRouter then issues an API key for it." }, result, cancel: lb.close };
}
// ---------------------------------------------------------------- ChatGPT plan (unofficial, Codex CLI client)
function chatgptCredential(body, previousRefresh) {
    if (typeof body?.access_token !== "string" || !body.access_token)
        throw new Error("ChatGPT sign-in returned no access token.");
    return {
        type: "oauth",
        access: body.access_token,
        refresh: body.refresh_token || previousRefresh,
        expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : jwtExpiry(body.access_token),
        accountId: chatgptAccountId(body.id_token, body.access_token),
        label: "ChatGPT sign-in",
        savedAt: savedAt(),
    };
}
async function chatgptFlow(ep, signal) {
    const pkce = pkcePair();
    const state = b64url(randomBytes(24));
    const lb = await loopback(ep.chatgptPorts, "/auth/callback", signal);
    const url = `${ep.chatgptIssuer}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CHATGPT_CLIENT_ID,
        redirect_uri: lb.redirectUri,
        scope: "openid profile email offline_access",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: "nexus",
    })}`;
    const result = (async () => {
        const p = await lb.params;
        if (p.get("state") !== state)
            throw new Error("ChatGPT sign-in returned a mismatched state; aborted.");
        const code = p.get("code");
        if (!code)
            throw new Error(`ChatGPT sign-in failed: ${p.get("error_description") ?? p.get("error") ?? "no code"}`);
        const body = await postForm(`${ep.chatgptIssuer}/oauth/token`, {
            grant_type: "authorization_code",
            code,
            redirect_uri: lb.redirectUri,
            client_id: CHATGPT_CLIENT_ID,
            code_verifier: pkce.verifier,
        }, {}, signal);
        return chatgptCredential(body);
    })();
    return { prompt: { url, instructions: "Sign in with your ChatGPT account in the browser (unofficial: uses the Codex CLI client)." }, result, cancel: lb.close };
}
// ---------------------------------------------------------------- GitHub Copilot (unofficial, VS Code client)
/** Exchanges a GitHub OAuth token for a short-lived Copilot API token. Nothing rotates. */
export async function copilotToken(githubToken, ep = endpoints, signal) {
    const res = await fetch(ep.copilotToken, {
        headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        redirect: "error",
    });
    if (res.status === 401 || res.status === 403)
        throw new Error("This GitHub account has no Copilot access (or the token was revoked).");
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.token !== "string")
        throw new Error(`Copilot token exchange failed (HTTP ${res.status}).`);
    return {
        type: "oauth",
        access: body.token,
        refresh: githubToken,
        expiresAt: typeof body.expires_at === "number" ? body.expires_at * 1000 : Date.now() + 25 * 60_000,
        label: "GitHub Copilot sign-in",
        savedAt: savedAt(),
    };
}
async function copilotFlow(ep, signal) {
    const dc = await postForm(ep.githubDeviceCode, { client_id: COPILOT_CLIENT_ID, scope: "read:user" }, { "User-Agent": COPILOT_HEADERS["User-Agent"] }, signal);
    if (typeof dc.device_code !== "string" || typeof dc.user_code !== "string")
        throw new Error("GitHub did not return a device code.");
    const ac = new AbortController();
    const both = AbortSignal.any([signal, ac.signal]);
    const result = (async () => {
        let interval = Math.max(ep.minPollMs, (dc.interval ?? 5) * 1000);
        const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
        while (Date.now() < deadline) {
            await new Promise((res, rej) => {
                const t = setTimeout(res, interval);
                both.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Sign-in cancelled.")); }, { once: true });
            });
            const r = await postForm(ep.githubAccessToken, {
                client_id: COPILOT_CLIENT_ID,
                device_code: dc.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }, { "User-Agent": COPILOT_HEADERS["User-Agent"] }, both);
            if (r.access_token)
                return copilotToken(r.access_token, ep, both);
            if (r.error === "authorization_pending")
                continue;
            if (r.error === "slow_down") {
                interval += 5_000;
                continue;
            }
            throw new Error(`GitHub sign-in failed: ${r.error_description ?? r.error ?? "unknown error"}`);
        }
        throw new Error("GitHub sign-in timed out.");
    })();
    return {
        prompt: { url: dc.verification_uri ?? "https://github.com/login/device", userCode: dc.user_code, instructions: `Open the page and enter code ${dc.user_code} (unofficial: uses the VS Code Copilot client).` },
        result,
        cancel: () => ac.abort(),
    };
}
export async function startAuthFlow(methodId, signal, ep = endpoints) {
    switch (methodId) {
        case "openrouter-oauth": return openrouterFlow(ep, signal);
        case "chatgpt-oauth": return chatgptFlow(ep, signal);
        case "copilot-device": return copilotFlow(ep, signal);
        default: throw new Error(`Unknown sign-in method '${methodId}'.`);
    }
}
/** Provider-owned refresh of a Nexus-owned OAuth credential (one attempt). */
export async function refreshOAuth(providerId, cred, ep = endpoints, signal) {
    if (!cred.refresh)
        throw new Error("No refresh token: sign in again.");
    if (providerId === "copilot")
        return copilotToken(cred.refresh, ep, signal);
    if (providerId === "chatgpt") {
        const body = await postForm(`${ep.chatgptIssuer}/oauth/token`, { grant_type: "refresh_token", refresh_token: cred.refresh, client_id: CHATGPT_CLIENT_ID }, {}, signal);
        return { ...chatgptCredential(body, cred.refresh), accountId: chatgptAccountId(body.id_token, body.access_token) ?? cred.accountId };
    }
    throw new Error(`Provider '${providerId}' has no refresh flow.`);
}
/** Opens a URL in the operator's browser; best effort, the URL is always shown too. */
export async function openBrowser(url) {
    if (process.env.NEXUS_NO_BROWSER === "1")
        return;
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => { }).unref();
    }
    catch { }
}
