import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { admitAppRelease, appCompatibilityEvidence, assertAppReleaseEligible } from "../domain/releaseAdmission.js";
import type { AppReleaseRecord, AppReleaseState } from "../domain/records.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";

/**
 * One entry of the registry Radioso ships. The catalogue is the trust root: a manifest
 * may reference no digest that is not listed beside it here.
 */
export interface BuiltInAppRelease {
  readonly manifest: unknown;
  readonly artifactDigests: readonly string[];
}

/** The states an operator or a security response moves an admitted release into. */
type AppReleaseSecurityState = "deprecated" | "revoked" | "quarantined";

/**
 * A release as it stands right now, not only as it was admitted.
 *
 * `admissionEvidence` is the decision that was made; `currentCompatibility` is recomputed
 * against the version this host runs today. They can disagree — a host upgrade is exactly
 * when they do — and an operator needs to see which is which rather than be shown a
 * historical decision as though it still held.
 */
export interface AppReleaseView {
  readonly release: AppReleaseRecord;
  readonly currentCompatibility: ReturnType<typeof appCompatibilityEvidence>;
  readonly admissionEvidence: Readonly<Record<string, unknown>>;
}

interface AppReleaseSecurityTransition {
  readonly releaseId: string;
  readonly state: AppReleaseSecurityState;
  /** §21: a security decision names the person who made it. */
  readonly actorUserId: string;
  readonly accountId: string | null;
  /** Why, in the operator's own words. Bounded and stored on the audit record. */
  readonly reason: string;
}

interface AppReleaseAdmissionDependencies {
  readonly releases: AppReleaseRepositoryPort;
  readonly unitOfWork: AppsUnitOfWork;
  readonly builtInReleases: readonly BuiltInAppRelease[];
  readonly auditDelivery?: { drain(): Promise<number> };
  readonly logger: AppLogger;
  /** The Radioso version this host runs, or `null` when it cannot be determined. */
  readonly runningRadiosoVersion: string | null;
}

/**
 * Admits the built-in registry's releases. Release A has no publisher submission path: a
 * release exists because Radioso ships it, so admission runs once at start-up.
 *
 * Synchronisation only ever inserts. A release that already exists is left exactly as it
 * is, whatever state it is in, because a restart is not a security decision: deprecation,
 * revocation, and quarantine are made through {@link AppReleaseAdmissionService.transitionSecurityState}
 * and must survive the next boot.
 */
export class AppReleaseAdmissionService {
  constructor(private readonly dependencies: AppReleaseAdmissionDependencies) {}

  async syncBuiltInReleases(): Promise<void> {
    for (const builtIn of this.dependencies.builtInReleases) {
      try {
        await this.admit(builtIn);
      } catch {
        // A bad registry entry must not stop the platform from starting; the App it
        // describes simply never becomes installable. The thrown value is not read for
        // text, because a registry entry is input.
        this.dependencies.logger.error({}, "Failed to admit a built-in App release");
      }
    }
    await this.dependencies.auditDelivery?.drain();
  }

  private async admit(builtIn: BuiltInAppRelease): Promise<void> {
    const identity = readReleaseIdentity(builtIn.manifest);
    const existing = identity
      ? await this.dependencies.releases.findByAppIdAndVersion(identity.appId, identity.version)
      : null;

    const decision = admitAppRelease({
      manifest: builtIn.manifest,
      artifactCatalogue: new Set(builtIn.artifactDigests),
      // Immutability holds in every state, so this compares against whatever digest the
      // version already has rather than only against an admitted one.
      recordedManifestDigest: existing?.manifestDigest ?? null,
      runningRadiosoVersion: this.dependencies.runningRadiosoVersion,
    });

    if (decision.outcome === "rejected") {
      await this.dependencies.unitOfWork.run((repositories) => repositories.auditOutbox.enqueue([{
        workspaceId: null,
        accountId: null,
        eventType: "app.release.rejected",
        eventStatus: "failure",
        metadata: {
          appId: identity?.appId ?? null,
          version: identity?.version ?? null,
          admissionPolicyVersion: decision.policyVersion,
          issueCount: decision.issues.length,
          issueCodes: [...new Set(decision.issues.map((issue) => issue.code))],
        },
      }]));
      this.dependencies.logger.warn(
        { appId: identity?.appId, version: identity?.version, issueCount: decision.issues.length },
        "Built-in App release rejected by admission policy",
      );
      return;
    }

    await this.dependencies.unitOfWork.run(async (repositories) => {
      const record = await repositories.releases.insertIfAbsent({
        appId: decision.manifest.app.id,
        version: decision.manifest.version,
        manifest: decision.manifest,
        manifestDigest: decision.manifestDigest,
        artifactDigest: decision.artifactDigest,
        publisherId: decision.manifest.app.publisher.id,
        state: "admitted",
        admissionPolicyVersion: decision.policyVersion,
        admissionDecision: { evidence: decision.evidence },
      });
      if (!record) return;
      await repositories.auditOutbox.enqueue([{
        workspaceId: null,
        accountId: null,
        eventType: "app.release.admitted",
        eventStatus: "success",
        metadata: {
          appId: record.appId,
          version: record.version,
          releaseId: record.id,
          publisherId: record.publisherId,
          admissionPolicyVersion: record.admissionPolicyVersion,
          trustRoot: decision.evidence.trustRoot,
          evidence: decision.evidence,
        },
      }]);
    });
  }

  /**
   * The only writer of a release's security state. It is deliberately not a route yet:
   * Release A has no publisher console, but revocation has to be expressible and audited
   * so an incident response is a recorded decision — with a person and a reason attached —
   * rather than a manual row edit.
   */
  async transitionSecurityState(input: AppReleaseSecurityTransition): Promise<AppReleaseRecord> {
    const record = await this.dependencies.unitOfWork.run(async (repositories) => {
      const transitioned = await repositories.releases
        .transitionState(input.releaseId, input.state satisfies AppReleaseState);
      if (!transitioned) return null;
      await repositories.auditOutbox.enqueue([{
        workspaceId: null,
        accountId: input.accountId,
        eventType: `app.release.${input.state}`,
        eventStatus: "success",
        metadata: {
          appId: transitioned.appId,
          version: transitioned.version,
          releaseId: transitioned.id,
          state: transitioned.state,
          actorUserId: input.actorUserId,
          reason: input.reason,
        },
      }]);
      return transitioned;
    });
    if (!record) throw notFound("App release not found");
    await this.dependencies.auditDelivery?.drain();
    return record;
  }

  /**
   * What an operator may install today. A release admitted before a host upgrade can be
   * historically admitted and currently incompatible, and offering it would produce a plan
   * the apply then refuses, so this asks current eligibility rather than stored state.
   */
  async listInstallable(): Promise<AppReleaseView[]> {
    const releases = await this.dependencies.releases.listInstallable();
    return releases.filter((release) => this.isCurrentlyEligible(release)).map((release) => this.view(release));
  }

  async findInstallable(releaseId: string): Promise<AppReleaseView | null> {
    const release = await this.dependencies.releases.findById(releaseId);
    // Inspection is not an admission grant: operators need to see a revoked or
    // quarantined release's present state and historical evidence during an incident.
    if (!release) return null;
    return this.view(release);
  }

  private isCurrentlyEligible(release: AppReleaseRecord): boolean {
    try {
      assertAppReleaseEligible(release, this.dependencies.runningRadiosoVersion);
      return true;
    } catch {
      return false;
    }
  }

  private view(release: AppReleaseRecord): AppReleaseView {
    const evidence = release.admissionDecision.evidence;
    return {
      release,
      currentCompatibility: appCompatibilityEvidence(
        release.manifest.radiosoCompatibility,
        this.dependencies.runningRadiosoVersion,
      ),
      admissionEvidence: evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? evidence as Record<string, unknown>
        : {},
    };
  }
}

/** Best-effort identity read for the audit trail of a manifest that may not parse at all. */
const readReleaseIdentity = (manifest: unknown): { appId: string; version: string } | null => {
  if (!manifest || typeof manifest !== "object") return null;
  const document = manifest as Record<string, unknown>;
  const app = document.app;
  const appId = app && typeof app === "object" ? (app as Record<string, unknown>).id : null;
  if (typeof appId !== "string" || typeof document.version !== "string") return null;
  return { appId, version: document.version };
};
