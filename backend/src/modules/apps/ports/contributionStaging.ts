import type { AppPortResult } from "../domain/portOutcome.js";
import type { AppLifecycleEffect } from "./runtimeProvisioning.js";

export interface AppContributionStagingRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
  readonly releaseId: string;
  readonly contributionIds: readonly string[];
}

export interface AppContributionDetachRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
}

/**
 * Staged contributions are invisible to live conversations, schedules, webhooks, and UI
 * slots until activation (FR-028). The owning modules create those projections; the
 * Apps domain only asks, and only through this port. Every implementation MUST
 * deduplicate on `effect`, and MUST report failure as a typed code rather than by
 * throwing, so no adapter text reaches an operator-visible surface.
 */
export interface AppContributionStagingPort {
  stage(request: AppContributionStagingRequest): Promise<AppPortResult>;
  runSafeTests(request: AppContributionStagingRequest): Promise<AppPortResult>;
  detach(request: AppContributionDetachRequest): Promise<AppPortResult>;
}

/** Release A default: contribution adapters land with the runtime, so nothing is staged yet. */
export const createNoopAppContributionStaging = (): AppContributionStagingPort => ({
  stage: async () => ({ ok: true }),
  runSafeTests: async () => ({ ok: true }),
  detach: async () => ({ ok: true }),
});
