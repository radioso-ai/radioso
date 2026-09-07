import {
  appManifestSchema,
  releaseAValidationPolicy,
  validateManifest,
  type AdmittedManifest,
  type AppManifest,
  type ManifestValidationIssue,
  type ManifestValidationPolicy,
} from "@radioso/app-contract";

import { canonicalDigest } from "./canonicalJson.js";
import { AppsError } from "./errors.js";

/**
 * The Radioso-owned policy snapshot a decision is recorded against (FR-049a). Bump this
 * when the rules below change, so an existing decision stays readable as the judgement
 * that was actually made.
 */
export const APP_ADMISSION_POLICY_VERSION = "release-a.1";

/**
 * Release A has one trust root: the built-in registry Radioso ships. There is no
 * publisher PKI yet, so provenance records which root vouched for the artifact rather
 * than a signature that nobody can verify.
 */
interface AppReleaseProvenance {
  readonly kind: "built_in_registry";
}

/** Counts only. An admission decision must not become a second copy of the manifest. */
interface AppReleaseAdmissionEvidence {
  readonly contributionCount: number;
  readonly permissionCount: number;
  readonly destinationCount: number;
  readonly storageCollectionCount: number;
  readonly connectionSlotCount: number;
  readonly verifiedDigestCount: number;
}

type AppReleaseAdmissionDecision =
  | {
    readonly outcome: "admitted";
    readonly policyVersion: string;
    readonly provenance: AppReleaseProvenance;
    readonly manifest: AppManifest;
    readonly manifestDigest: string;
    readonly artifactDigest: string;
    readonly evidence: AppReleaseAdmissionEvidence;
  }
  | {
    readonly outcome: "rejected";
    readonly policyVersion: string;
    readonly issues: readonly ManifestValidationIssue[];
  };

interface AppReleaseAdmissionInput {
  readonly manifest: unknown;
  /** Every digest the registry vouches for; a manifest may reference no other. */
  readonly artifactCatalogue: ReadonlySet<string>;
  /** The digest already admitted for this app id and version, when there is one. */
  readonly admittedManifestDigest?: string | null;
  readonly policy?: ManifestValidationPolicy;
}

export const appManifestDigest = (manifest: unknown): string => canonicalDigest(manifest);

const digestIssues = (
  manifest: AdmittedManifest,
  catalogue: ReadonlySet<string>,
): ManifestValidationIssue[] => {
  const referenced: Array<{ digest: string; path: string }> = [
    { digest: manifest.artifact.digest, path: "artifact.digest" },
    ...(manifest.companionAssets ?? []).map((asset, index) => ({
      digest: asset.digest,
      path: `companionAssets[${index}].digest`,
    })),
  ];
  return referenced
    .filter((reference) => !catalogue.has(reference.digest))
    .map((reference) => ({
      code: "artifact_digest_not_in_catalogue",
      path: reference.path,
      message: "The registry does not vouch for this digest.",
    }));
};

/**
 * Release A admission: the contract policy, then digest provenance, then version
 * immutability. All three run so an operator sees every reason at once rather than
 * fixing one and discovering the next.
 */
export const admitAppRelease = (input: AppReleaseAdmissionInput): AppReleaseAdmissionDecision => {
  const policyVersion = APP_ADMISSION_POLICY_VERSION;
  const validation = validateManifest(input.manifest, input.policy ?? releaseAValidationPolicy);
  if (!validation.ok) return { outcome: "rejected", policyVersion, issues: validation.issues };

  const manifest = validation.manifest;
  const manifestDigest = appManifestDigest(input.manifest);
  const issues = digestIssues(manifest, input.artifactCatalogue);

  // FR-008: a published release is immutable. Changed content is a new version, never a
  // silent overwrite of the one workspaces already installed.
  if (input.admittedManifestDigest && input.admittedManifestDigest !== manifestDigest) {
    issues.push({
      code: "release_version_immutable",
      path: "version",
      message: "This version is already admitted with different content. Publish a new version.",
    });
  }

  if (issues.length > 0) return { outcome: "rejected", policyVersion, issues };

  // The decision's `manifest` field is the persisted shape (FR-008 immutability lives in
  // storage, not in this admitted value), so it is serialised into a plain, mutable copy
  // here at the one boundary that writes it out. The admitted, deeply-readonly `manifest`
  // above stays what every read-only computation in this function uses.
  const persistedManifest: AppManifest = appManifestSchema.parse(manifest);

  return {
    outcome: "admitted",
    policyVersion,
    provenance: { kind: "built_in_registry" },
    manifest: persistedManifest,
    manifestDigest,
    artifactDigest: manifest.artifact.digest,
    evidence: {
      contributionCount: manifest.contributions.length,
      permissionCount: manifest.permissions.length,
      destinationCount: manifest.destinations.length,
      storageCollectionCount: manifest.storageCollections.length,
      connectionSlotCount: manifest.connections.slots.length,
      verifiedDigestCount: 1 + (manifest.companionAssets?.length ?? 0),
    },
  };
};

/**
 * Every admission policy version this host can still re-check a stored manifest against.
 * Release A ships one; a future policy bump adds an entry here rather than replacing this
 * one, so a release admitted under an older policy stays re-admittable exactly as it was
 * decided.
 */
const admissionPoliciesByVersion: Readonly<Record<string, ManifestValidationPolicy>> = {
  [APP_ADMISSION_POLICY_VERSION]: releaseAValidationPolicy,
};

/** The minimum a caller needs to re-admit a stored release: its manifest and the policy version it was admitted under. */
interface AdmittableAppRelease {
  readonly manifest: AppManifest;
  readonly admissionPolicyVersion?: string;
}

/**
 * Re-admission is the one boundary a manifest loaded back from storage crosses on its way
 * to `resolveInstallation` and the plan builder, both of which only accept an
 * `AdmittedManifest`. Storage keeps `AppManifest`, the persisted shape; nothing there earns
 * the `AdmittedManifest` brand for free, so stored-state corruption — a hand-edited row, a
 * policy this host no longer runs — surfaces here as a typed failure instead of a cast that
 * would hide it. A release without a recorded policy version is re-checked against the
 * current one, which is the only sound default for data admitted before this field existed.
 */
export const admittedManifestOf = (release: AdmittableAppRelease): AdmittedManifest => {
  const policyVersion = release.admissionPolicyVersion ?? APP_ADMISSION_POLICY_VERSION;
  const policy = admissionPoliciesByVersion[policyVersion];
  if (!policy) {
    throw new AppsError(
      "release_not_admitted",
      "This release was admitted under a policy this host no longer runs.",
      { admissionPolicyVersion: policyVersion },
    );
  }

  const validation = validateManifest(release.manifest, policy);
  if (!validation.ok) {
    throw new AppsError(
      "release_not_admitted",
      "The stored release manifest no longer passes admission.",
      { issueCount: validation.issues.length },
    );
  }

  return validation.manifest;
};
