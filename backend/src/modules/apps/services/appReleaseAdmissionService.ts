import { notFound } from "../../../shared/domain/errors.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { admitAppRelease } from "../domain/releaseAdmission.js";
import type { AppReleaseRecord, AppReleaseState } from "../domain/records.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";

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

interface AppReleaseAdmissionDependencies {
  readonly releases: AppReleaseRepositoryPort;
  readonly builtInReleases: readonly BuiltInAppRelease[];
  readonly audit: Pick<AuditPort, "record">;
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
      } catch (error) {
        // A bad registry entry must not stop the platform from starting; the App it
        // describes simply never becomes installable.
        this.dependencies.logger.error(
          { err: error },
          "Failed to admit a built-in App release",
        );
      }
    }
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
      await this.dependencies.audit.record({
        eventType: "app.release.rejected",
        eventStatus: "failure",
        metadata: {
          appId: identity?.appId ?? null,
          version: identity?.version ?? null,
          admissionPolicyVersion: decision.policyVersion,
          issueCount: decision.issues.length,
          issueCodes: [...new Set(decision.issues.map((issue) => issue.code))],
        },
      });
      this.dependencies.logger.warn(
        { appId: identity?.appId, version: identity?.version, issueCount: decision.issues.length },
        "Built-in App release rejected by admission policy",
      );
      return;
    }

    const record = await this.dependencies.releases.insertIfAbsent({
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

    await this.dependencies.audit.record({
      eventType: "app.release.admitted",
      eventStatus: "success",
      metadata: {
        appId: record.appId,
        version: record.version,
        releaseId: record.id,
        publisherId: record.publisherId,
        admissionPolicyVersion: record.admissionPolicyVersion,
        provenance: decision.evidence.provenance,
        evidence: decision.evidence,
      },
    });
  }

  /**
   * The only writer of a release's security state. It is deliberately not a route yet:
   * Release A has no publisher console, but revocation has to be expressible and audited
   * so an incident response is a recorded decision rather than a manual row edit.
   */
  async transitionSecurityState(
    releaseId: string,
    state: AppReleaseSecurityState,
  ): Promise<AppReleaseRecord> {
    const record = await this.dependencies.releases.transitionState(releaseId, state satisfies AppReleaseState);
    if (!record) throw notFound("App release not found");
    await this.dependencies.audit.record({
      eventType: `app.release.${state}`,
      eventStatus: "success",
      metadata: {
        appId: record.appId,
        version: record.version,
        releaseId: record.id,
        state: record.state,
      },
    });
    return record;
  }

  listInstallable(): Promise<AppReleaseRecord[]> {
    return this.dependencies.releases.listInstallable();
  }

  findInstallable(releaseId: string): Promise<AppReleaseRecord | null> {
    return this.dependencies.releases.findById(releaseId).then(
      (release) => (release && release.state === "admitted" ? release : null),
    );
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
