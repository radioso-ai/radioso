import { resolveInstallation } from "@radioso/app-contract";

import { findAppContributionDescriptor, type AppContributionDescriptor } from "../domain/contributionDescriptor.js";
import {
  admittedManifestOf,
  appCompatibilityEvidence,
  existingInstallationReleaseStates,
} from "../domain/releaseAdmission.js";
import type { AppsTransactionalRepositories, AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";

/** Why a contribution may not run. Every refusal names exactly one of these. */
type AppExecutionIneligibilityReason =
  | "installation_not_found"
  | "installation_not_active"
  | "execution_denied"
  | "release_missing"
  | "release_not_usable"
  | "release_changed"
  | "release_incompatible"
  | "contribution_not_granted"
  | "contribution_not_active"
  | "connections_unbound"
  | "eligibility_unavailable";

export interface AppExecutionEligibilityQuery {
  readonly installationId: string;
  /** The contribution the caller is about to grant authority to. */
  readonly contributionId: string;
  /**
   * The manifest digest the caller's projection was built from. It is required, not
   * optional: an optional fence is one every caller may quietly decline, and a stale
   * projection for release X evaluated against the release Y that now carries the same
   * contribution id is exactly the confusion this exists to refuse.
   */
  readonly expectedReleaseDigest: string;
}

export type AppExecutionEligibility =
  | {
    readonly eligible: true;
    /** The installation revision this answer is good for; it is good for one attempt. */
    readonly installationVersion: number;
    readonly releaseDigest: string;
    readonly contribution: AppContributionDescriptor;
    /** Frozen, exactly as `resolveInstallation` produced it. */
    readonly configuration: Readonly<Record<string, unknown>>;
  }
  | { readonly eligible: false; readonly reason: AppExecutionIneligibilityReason };

export interface AppExecutionEligibilityPort {
  evaluate(query: AppExecutionEligibilityQuery): Promise<AppExecutionEligibility>;
}

interface AppExecutionEligibilityDependencies {
  readonly unitOfWork: AppsUnitOfWork;
  readonly runningRadiosoVersion: string | null;
}

/**
 * The Apps-owned answer to "may this contribution run right now" (architecture §5).
 *
 * Every runtime path — the invocation gateway, the App-job consumer, the webhook and
 * schedule admission paths — asks this immediately before granting authority, so the
 * lifecycle, release, grant, and connection rules stay in the domain that owns them
 * instead of being reconstructed by each caller against Apps persistence. The reads run in
 * one transaction, because four independent reads can observe four different lifecycle
 * moments. The answer is fail-closed, and a positive answer is the whole thing the caller
 * needs — the exact contribution and the frozen configuration — so nothing downstream
 * re-derives it.
 *
 * A deprecated release still runs for the installations that already have it: deprecation
 * stops new installs, it is not a stop-work order. Revocation and quarantine are.
 */
export class AppExecutionEligibilityService implements AppExecutionEligibilityPort {
  constructor(private readonly dependencies: AppExecutionEligibilityDependencies) {}

  async evaluate(query: AppExecutionEligibilityQuery): Promise<AppExecutionEligibility> {
    try {
      // One snapshot for the whole decision. Under the default per-statement view a
      // disable landing between the installation read and the connection read produces an
      // answer that describes no instant that ever existed.
      return await this.dependencies.unitOfWork.run(
        (repositories) => this.decide(query, repositories),
        { snapshot: true },
      );
    } catch {
      return { eligible: false, reason: "eligibility_unavailable" };
    }
  }

  private async decide(
    query: AppExecutionEligibilityQuery,
    repositories: AppsTransactionalRepositories,
  ): Promise<AppExecutionEligibility> {
    const installation = await repositories.installations.findAnyById(query.installationId);
    if (!installation) return { eligible: false, reason: "installation_not_found" };
    // Disable and removal close this gate in their first transaction, before any runtime is
    // stopped, so nothing new is admitted during the teardown window.
    if (installation.executionDeniedAt !== null) return { eligible: false, reason: "execution_denied" };
    if (installation.state !== "active") return { eligible: false, reason: "installation_not_active" };

    const releaseId = installation.activeReleaseId;
    const release = releaseId ? await repositories.releases.findById(releaseId) : null;
    if (!release) return { eligible: false, reason: "release_missing" };
    if (!(existingInstallationReleaseStates as readonly string[]).includes(release.state)) {
      return { eligible: false, reason: "release_not_usable" };
    }
    if (query.expectedReleaseDigest !== release.manifestDigest) {
      return { eligible: false, reason: "release_changed" };
    }

    const manifest = admittedManifestOf(release);
    const compatibility = appCompatibilityEvidence(
      manifest.radiosoCompatibility,
      this.dependencies.runningRadiosoVersion,
    );
    if (compatibility.result !== "compatible") return { eligible: false, reason: "release_incompatible" };

    const granted = (await repositories.grants.listLive(installation.id))
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
      (await repositories.connections.listByInstallation(installation.id))
        .filter((connection) => connection.deletionRequestedAt === null)
        .map((connection) => connection.slotId),
    );
    if (resolved.readiness.requiredConnectionSlots.some((slotId) => !bound.has(slotId))) {
      return { eligible: false, reason: "connections_unbound" };
    }

    const contribution = findAppContributionDescriptor(manifest, resolved.configuration, query.contributionId);
    if (!contribution) return { eligible: false, reason: "contribution_not_active" };

    return {
      eligible: true,
      installationVersion: installation.version,
      releaseDigest: release.manifestDigest,
      contribution,
      configuration: resolved.configuration,
    };
  }
}
