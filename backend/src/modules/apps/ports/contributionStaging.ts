export interface AppContributionStagingRequest {
  readonly installationId: string;
  readonly releaseId: string;
  readonly contributionIds: readonly string[];
}

/**
 * Staged contributions are invisible to live conversations, schedules, webhooks, and UI
 * slots until activation (FR-028). The owning modules create those projections; the
 * Apps domain only asks, and only through this port.
 */
export interface AppContributionStagingPort {
  stage(request: AppContributionStagingRequest): Promise<void>;
  runSafeTests(request: AppContributionStagingRequest): Promise<void>;
  detach(request: { readonly installationId: string }): Promise<void>;
}

/** Release A default: contribution adapters land with the runtime, so nothing is staged yet. */
export const createNoopAppContributionStaging = (): AppContributionStagingPort => ({
  stage: async () => {},
  runSafeTests: async () => {},
  detach: async () => {},
});
