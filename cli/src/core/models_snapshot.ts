import { MODELS_SNAPSHOT } from "../providers.generated.js";

export interface SnapshotModel {
  id: string;
  context: number;
  output: number;
  input?: number;
  toolCall: boolean;
  toolChoice?: string[];
  reasoning: boolean;
  effort?: string[];
  price?: { input: number; output: number };
}

export interface SnapshotProvider {
  id: string;
  name: string;
  env: string[];
  protocol: string;
  baseUrl?: string;
  models: SnapshotModel[];
}

export interface ModelsSnapshot {
  date: string;
  commit?: string;
  license: string;
  source: string;
  providers: SnapshotProvider[];
}

export type ToolChoiceMode = "auto" | "none" | "required" | "tool";

const providerIndex = new Map<string, SnapshotProvider>();
const modelIndex = new Map<SnapshotProvider, Map<string, SnapshotModel>>();

function load(snapshot: ModelsSnapshot): void {
  providerIndex.clear();
  modelIndex.clear();
  for (const p of snapshot.providers) {
    providerIndex.set(p.id, p);
    modelIndex.set(p, new Map(p.models.map((m) => [m.id, m])));
  }
}
load(MODELS_SNAPSHOT);

export function snapshotDate(): string {
  return MODELS_SNAPSHOT.date;
}

export function snapshotProviders(): readonly SnapshotProvider[] {
  return MODELS_SNAPSHOT.providers;
}

export function snapshotProvider(providerId: string): SnapshotProvider | undefined {
  return providerIndex.get(providerId);
}

export function snapshotModel(providerId: string, modelId: string): SnapshotModel | undefined {
  const provider = providerIndex.get(providerId);
  return provider ? modelIndex.get(provider)?.get(modelId) : undefined;
}

/** Context window in tokens, or `fallback` (default undefined) when the snapshot has no positive figure. */
export function resolveContext(providerId: string, modelId: string, fallback?: number): number | undefined {
  const context = snapshotModel(providerId, modelId)?.context;
  return context && context > 0 ? context : fallback;
}

/**
 * true: the model lists the mode; false: it lists modes and this is not one of them; "unknown": the snapshot has no
 * tool-choice data for it (unknown provider or model, or no `capabilities.tools.choice`), so the caller must not assume.
 */
export function acceptsToolChoice(providerId: string, modelId: string, mode: ToolChoiceMode): boolean | "unknown" {
  const modes = snapshotModel(providerId, modelId)?.toolChoice;
  return modes ? modes.includes(mode) : "unknown";
}
