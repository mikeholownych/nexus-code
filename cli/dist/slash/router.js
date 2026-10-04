/** Runs one slash command for the sidecar. Handlers never write to stdout; everything comes back as an outcome. */
import { stripEscapes } from "../protocol.js";
import { errorText, findSlash, reply } from "./catalog.js";
import { EXTENSION_HANDLERS } from "./extension_commands.js";
import { SESSION_HANDLERS } from "./session_commands.js";
import { WORKSPACE_HANDLERS } from "./workspace_commands.js";
const HANDLERS = { ...SESSION_HANDLERS, ...WORKSPACE_HANDLERS, ...EXTENSION_HANDLERS };
export function hasHandler(name) {
    return Object.hasOwn(HANDLERS, name);
}
export async function routeSlash(host, command, args, signal) {
    const spec = findSlash(command);
    const name = spec?.name ?? command.trim().replace(/^\//, "").toLowerCase();
    const handler = spec && hasHandler(spec.name) ? HANDLERS[spec.name] : undefined;
    if (!handler)
        return reply(name, `Unknown command: /${name}. Type /help for the list.`, false);
    try {
        const outcome = await handler({ host, args, signal });
        return outcome.kind === "reply" ? { ...outcome, output: stripEscapes(outcome.output) } : outcome;
    }
    catch (err) {
        return reply(name, `${name === "!" ? "!" : `/${name}`} failed: ${errorText(err)}`, false);
    }
}
