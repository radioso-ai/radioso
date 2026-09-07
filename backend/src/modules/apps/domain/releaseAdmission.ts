import {
  releaseAValidationPolicy,
  validateManifest,
  type AppManifest,
  type ManifestValidationIssue,
  type ManifestValidationPolicy,
} from "@radioso/app-contract";

import { canonicalDigest } from "./canonicalJson.js";

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
  manifest: AppManifest,
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

  return {
    outcome: "admitted",
    policyVersion,
    provenance: { kind: "built_in_registry" },
    manifest,
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
