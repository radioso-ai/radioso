import type { AppContributionDescriptor } from "../domain/contributionDescriptor.js";
import type { AppPortResult } from "../domain/portOutcome.js";
import type { AppLifecycleEffect } from "./runtimeProvisioning.js";

/** Which release the projection belongs to, pinned by the digest that admission recorded. */
export interface AppReleaseDescriptor {
  readonly id: string;
  readonly appId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly artifactDigest: string;
}

/**
 * What is being staged or tested, said completely.
 *
 * `candidateRevision` names this proposal. An install stages the configuration the
 * installation already holds; a reconfigure stages a candidate the installation has not
 * adopted, and only adopts it once staging and testing accept. Either way the projection
 * is built from `effectiveConfiguration` and `contributions`, never from ids the
 * implementation would have to re-resolve against a manifest it does not own.
 */
export interface AppContributionStagingRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
  readonly workspaceId: string;
  readonly release: AppReleaseDescriptor;
  readonly candidateRevision: string;
  /** Frozen, as `resolveInstallation` produced it. */
  readonly effectiveConfiguration: Readonly<Record<string, unknown>>;
  readonly contributions: readonly AppContributionDescriptor[];
}

export interface AppContributionDetachRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
}

/** Drops a staged candidate that was never adopted, named by the revision that staged it. */
export interface AppCandidateDiscardRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
  readonly candidateRevision: string;
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
  /** Compensator for a staged candidate the operation went on to abandon. */
  discardCandidate(request: AppCandidateDiscardRequest): Promise<AppPortResult>;
}

/** Release A default: contribution adapters land with the runtime, so nothing is staged yet. */
export const createNoopAppContributionStaging = (): AppContributionStagingPort => ({
  stage: async () => ({ ok: true }),
  runSafeTests: async () => ({ ok: true }),
  detach: async () => ({ ok: true }),
  discardCandidate: async () => ({ ok: true }),
});
