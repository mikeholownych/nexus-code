/** Shared by fixtures and the guard. Scripted gateways register here whether or not a test file imports `leak_guard`; nothing checks them unless it does. */
export interface Tracked {
  kind: string;
  name: string;
  alive: () => boolean;
  release: () => unknown;
}

const key = Symbol.for("nexus.test.leakRegistry");
const g = globalThis as unknown as Record<symbol, Set<Tracked> | undefined>;
const registry: Set<Tracked> = (g[key] ??= new Set());

/** Registers a resource a test file must release before it ends; `alive` says whether it still needs releasing. */
export function trackResource(kind: string, name: string, alive: () => boolean, release: () => unknown): Tracked {
  const entry = { kind, name, alive, release };
  registry.add(entry);
  return entry;
}

export function survivors(): Tracked[] {
  return [...registry].filter((t) => t.alive());
}

export function clearTracked(): void {
  registry.clear();
}
