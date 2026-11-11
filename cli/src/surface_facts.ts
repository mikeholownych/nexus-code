/**
 * The session facts every surface reports (v1.1.4 gate I-3): the REPL /status and the sidecar session.state event
 * (which the TUI status line renders) read them from here, so they cannot drift apart.
 */
import type { ApplicationCore } from "./core/app.js";
import { disclosureClass } from "./providers.js";

export interface SurfaceFacts {
  mode: "auto" | "review" | "read-only";
  read_only: boolean;
  /** Estimated tokens the conversation takes of the context window. */
  context_tokens: number;
  context_limit: number;
  /** "<provider> · <model>" for a named provider, the model alone otherwise. */
  model: string;
  endpoint_kind: "local" | "cloud";
  session: string;
}

export function surfaceFacts(app: ApplicationCore, sessionId: string): SurfaceFacts {
  const config = app.getConfig();
  const agent = app.getAgent();
  const budget = agent.getContextBudget();
  return {
    mode: agent.getApprovalMode(),
    read_only: Boolean(config.readOnly),
    context_tokens: budget.totalActiveTokens,
    context_limit: budget.contextLimit,
    model: config.provider ? `${config.provider} · ${config.model}` : config.model,
    endpoint_kind: disclosureClass(config.endpoint, config.provider, config.cloudRoutedOrigins),
    session: sessionId,
  };
}
