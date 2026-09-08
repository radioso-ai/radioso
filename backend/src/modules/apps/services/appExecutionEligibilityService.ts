import { resolveInstallation } from "@radioso/app-contract";

import { admittedManifestOf, appCompatibilityEvidence } from "../domain/releaseAdmission.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppGrantRepositoryPort } from "../repositories/appGrantRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";

/** Why a contribution may not run. Every refusal names exactly one of these. */
type AppExecutionIneligibilityReason =
  | "installation_not_found"
  | "installation_not_active"
  | "release_missing"
  | "release_not_admitted"
  | "release_incompatible"
  | "contribution_not_granted"
  | "contribution_not_active"
  | "connections_unbound"
  | "eligibility_unavailable";

export interface AppExecutionEligibilityQuery {
  readonly installationId: string;
  /** The contribution the caller is about to grant authority to. */
  readonly contributionId: string;
}

export type AppExecutionEligibility =
  | {
    readonly eligible: true;
    readonly releaseDigest: string;
    readonly activeContributionIds: readonly string[];
  }
  | { readonly eligible: false; readonly reason: AppExecutionIneligibilityReason };

export interface AppExecutionEligibilityPort {
  evaluate(query: AppExecutionEligibilityQuery): Promise<AppExecutionEligibility>;
}

interface AppExecutionEligibilityDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly grants: AppGrantRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly runningRadiosoVersion: string | null;
}

/**
 * The Apps-owned answer to "may this contribution run right now" (architecture §5).
 *
 * Every runtime path — the invocation gateway, the App-job consumer, the webhook and
 * schedule admission paths — asks this immediately before granting authority, so the
 * lifecycle, release, grant, and connection rules stay in the domain that owns them
 * instead of being reconstructed by each caller against Apps persistence. The answer is
 * fail-closed: anything that cannot be established is a refusal, and a positive answer is
 * good for exactly the one attempt that asked.
 */
export class AppExecutionEligibilityService implements AppExecutionEligibilityPort {
  constructor(private readonly dependencies: AppExecutionEligibilityDependencies) {}

  async evaluate(query: AppExecutionEligibilityQuery): Promise<AppExecutionEligibility> {
    try {
      return await this.decide(query);
    } catch {
      return { eligible: false, reason: "eligibility_unavailable" };
    }
  }

  private async decide(query: AppExecutionEligibilityQuery): Promise<AppExecutionEligibility> {
    const installation = await this.dependencies.installations.findAnyById(query.installationId);
    if (!installation) return { eligible: false, reason: "installation_not_found" };
    if (installation.state !== "active") return { eligible: false, reason: "installation_not_active" };

    const releaseId = installation.activeReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) return { eligible: false, reason: "release_missing" };
    if (release.state !== "admitted") return { eligible: false, reason: "release_not_admitted" };

    const manifest = admittedManifestOf(release);
    const compatibility = appCompatibilityEvidence(
      manifest.radiosoCompatibility,
      this.dependencies.runningRadiosoVersion,
    );
    if (compatibility.result !== "compatible") return { eligible: false, reason: "release_incompatible" };

    const granted = (await this.dependencies.grants.listLive(installation.id))
      .some((grant) => grant.kind === "contribution"
        && grant.key === query.contributionId
        && grant.releaseId === release.id);
    if (!granted) return { eligible: false, reason: "contribution_not_granted" };

    const resolved = resolveInstallation(manifest, installation.configuration);
    if (!resolved.ok) return { eligible: false, reason: "eligibility_unavailable" };
    if (!resolved.readiness.activeContributionIds.includes(query.contributionId)) {
      return { eligible: false, reason: "contribution_not_active" };
    }

    const bound = new Set(
      (await this.dependencies.connections.listByInstallation(installation.id))
        .filter((connection) => connection.deletionRequestedAt === null)
        .map((connection) => connection.slotId),
    );
    if (resolved.readiness.requiredConnectionSlots.some((slotId) => !bound.has(slotId))) {
      return { eligible: false, reason: "connections_unbound" };
    }

    return {
      eligible: true,
      releaseDigest: release.manifestDigest,
      activeContributionIds: [...resolved.readiness.activeContributionIds],
    };
  }
}
