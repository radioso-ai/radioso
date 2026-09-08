import type { AppPortResult } from "../domain/portOutcome.js";
import type { AppLifecycleEffect } from "./runtimeProvisioning.js";

export const appDataDispositions = ["export", "retain", "delete"] as const;
export type AppDataDisposition = (typeof appDataDispositions)[number];

export interface AppManagedDataDispositionRequest {
  readonly effect: AppLifecycleEffect;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly disposition: AppDataDisposition;
}

/**
 * What happens to an installation's managed records when it is removed. Implementations
 * MUST deduplicate on `effect` — disposing twice is not the same as disposing once — and
 * MUST report failure as a typed code rather than by throwing.
 */
export interface AppManagedDataDispositionPort {
  dispose(request: AppManagedDataDispositionRequest): Promise<AppPortResult>;
}

/** Release A default: managed collections arrive with `appStorage`, so there is nothing to dispose. */
export const createNoopAppManagedDataDisposition = (): AppManagedDataDispositionPort => ({
  dispose: async () => ({ ok: true }),
});
