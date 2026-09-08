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
import type { AppReleaseState } from "./records.js";
import { satisfiesSemanticVersionRange } from "./semanticVersion.js";

/**
 * The Radioso-owned policy snapshot a decision is recorded against (FR-049a). Bump this
 * when the rules below change, so an existing decision stays readable as the judgement
 * that was actually made.
 */
export const APP_ADMISSION_POLICY_VERSION = "release-a.1";

/**
 * What admission actually established, said plainly. Release A runs the contract policy,
 * digest provenance, host compatibility, and version immutability; the five named
 * hardening checks below — signature, provenance attestation, software inventory,
 * vulnerability policy, and conformance execution — are deferred, and each is recorded as
 * `not_evaluated`, because a decision that omits a check, or that names its trust root in
 * the check's own field, reads later as though the check passed. Which root vouched for
 * the release is a separate fact, so it has a separate field.
 */
type AppAdmissionEvidenceOutcome = "not_evaluated";

/** Who vouched for the release. Release A has one root: the registry Radioso ships. */
type AppAdmissionTrustRoot = "built_in_registry";

interface AppCompatibilityEvidence {
  /** `null` when the host could not determine its own version, which fails admission closed. */
  readonly runningVersion: string | null;
  readonly range: string;
  readonly result: "compatible" | "incompatible" | "undetermined";
}

interface AppReleaseAdmissionEvidence {
  readonly trustRoot: AppAdmissionTrustRoot;
  /** Publisher signature verification arrives with the publisher pipeline. */
  readonly signature: AppAdmissionEvidenceOutcome;
  readonly provenance: AppAdmissionEvidenceOutcome;
  /** Software inventory and vulnerability policy arrive with the publisher pipeline. */
  readonly softwareInventory: AppAdmissionEvidenceOutcome;
  readonly vulnerabilityPolicy: AppAdmissionEvidenceOutcome;
  /** Conformance execution arrives with the App runtime. */
  readonly conformance: AppAdmissionEvidenceOutcome;
  readonly compatibility: AppCompatibilityEvidence;
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
  /**
   * The digest already recorded for this app id and version, in whatever state that row
   * is in. Immutability is a property of the version, not of the admitted state: a
   * revoked version must not come back with different content either.
   */
  readonly recordedManifestDigest?: string | null;
  /** The Radioso version this host runs, or `null` when it cannot be determined. */
  readonly runningRadiosoVersion: string | null;
  readonly policy?: ManifestValidationPolicy;
}

/**
 * The digest is taken over the parsed manifest, which is also the shape persisted, so
 * `manifest_digest` always describes the bytes storage actually holds and re-admission
 * can prove it.
 */
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

/** Compatibility is evidence, so it is computed once and both recorded and acted on. */
export const appCompatibilityEvidence = (
  range: string,
  runningVersion: string | null,
): AppCompatibilityEvidence => ({
  runningVersion,
  range,
  result: runningVersion === null
    ? "undetermined"
    : satisfiesSemanticVersionRange(runningVersion, range) ? "compatible" : "incompatible",
});

/**
 * Release A admission: the contract policy, then digest provenance, then compatibility
 * with the running host, then version immutability. All four run so an operator sees
 * every reason at once rather than fixing one and discovering the next.
 */
export const admitAppRelease = (input: AppReleaseAdmissionInput): AppReleaseAdmissionDecision => {
  const policyVersion = APP_ADMISSION_POLICY_VERSION;
  const validation = validateManifest(input.manifest, input.policy ?? releaseAValidationPolicy);
  if (!validation.ok) return { outcome: "rejected", policyVersion, issues: validation.issues };

  const manifest = validation.manifest;
  const persistedManifest: AppManifest = appManifestSchema.parse(manifest);
  const manifestDigest = appManifestDigest(persistedManifest);
  const issues = digestIssues(manifest, input.artifactCatalogue);

  const compatibility = appCompatibilityEvidence(manifest.radiosoCompatibility, input.runningRadiosoVersion);
  if (compatibility.result !== "compatible") {
    issues.push({
      code: compatibility.result === "undetermined"
        ? "radioso_version_undetermined"
        : "radioso_version_incompatible",
      path: "radiosoCompatibility",
      message: compatibility.result === "undetermined"
        ? "This host cannot determine which Radioso version it runs, so compatibility cannot be established."
        : "This release does not support the Radioso version this host runs.",
    });
  }

  // FR-008: a published release is immutable. Changed content is a new version, never a
  // silent overwrite of the one workspaces already installed — and never a rewrite of a
  // version that was deprecated, revoked, or quarantined either.
  if (input.recordedManifestDigest && input.recordedManifestDigest !== manifestDigest) {
    issues.push({
      code: "release_version_immutable",
      path: "version",
      message: "This version already exists with different content. Publish a new version.",
    });
  }

  if (issues.length > 0) return { outcome: "rejected", policyVersion, issues };

  return {
    outcome: "admitted",
    policyVersion,
    manifest: persistedManifest,
    manifestDigest,
    artifactDigest: manifest.artifact.digest,
    evidence: {
      trustRoot: "built_in_registry",
      signature: "not_evaluated",
      provenance: "not_evaluated",
      softwareInventory: "not_evaluated",
      vulnerabilityPolicy: "not_evaluated",
      conformance: "not_evaluated",
      compatibility,
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

/** The minimum a caller needs to re-admit a stored release: its manifest, digest, and policy version. */
interface AdmittableAppRelease {
  readonly manifest: AppManifest;
  readonly manifestDigest: string;
  readonly admissionPolicyVersion?: string;
}

/**
 * Re-admission is the one boundary a manifest loaded back from storage crosses on its way
 * to `resolveInstallation`, the plan builder, and every rule that reads what a slot or a
 * destination means. Storage keeps `AppManifest`, the persisted shape; nothing there earns
 * the `AdmittedManifest` brand for free. The recorded digest is checked first, so
 * stored-state corruption — a hand-edited row, a migration gone wrong — cannot present a
 * structurally valid but different document and earn a fresh admitted brand for it.
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

  if (appManifestDigest(release.manifest) !== release.manifestDigest) {
    throw new AppsError(
      "release_not_admitted",
      "The stored release manifest no longer matches the digest admission recorded for it.",
      { cause: "manifest_digest_mismatch" },
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

interface EligibleAppRelease extends AdmittableAppRelease {
  readonly state: string;
  readonly manifest: AppManifest;
}

/**
 * The release states a *new* installation may be created or first activated against.
 * Deprecation is a decision to stop offering a release, so it excludes exactly this.
 */
export const newInstallReleaseStates = ["admitted"] as const satisfies readonly AppReleaseState[];

/**
 * The release states an installation that already exists may keep working against.
 * Deprecation stops new installs; it is not a stop-work order for the operators who
 * already have the App, so reconfiguring, re-enabling, binding a connection, and executing
 * a contribution all still hold. Revocation and quarantine are the stop-work orders.
 */
export const existingInstallationReleaseStates = ["admitted", "deprecated"] as const satisfies readonly AppReleaseState[];

const assertReleaseUsable = (
  release: EligibleAppRelease,
  runningRadiosoVersion: string | null,
  allowedStates: readonly AppReleaseState[],
  refusal: string,
): AdmittedManifest => {
  if (!(allowedStates as readonly string[]).includes(release.state)) {
    throw new AppsError("release_not_eligible", refusal, { releaseState: release.state });
  }
  const manifest = admittedManifestOf(release);
  const compatibility = appCompatibilityEvidence(manifest.radiosoCompatibility, runningRadiosoVersion);
  if (compatibility.result !== "compatible") {
    throw new AppsError(
      "release_not_eligible",
      compatibility.result === "undetermined"
        ? "This host cannot determine which Radioso version it runs, so this release cannot be used."
        : "This release does not support the Radioso version this host runs.",
      { compatibility: compatibility.result },
    );
  }
  return manifest;
};

/**
 * Whether a release may found a *new* installation right now (FR-049c). Planning binds the
 * admission policy version and the state it saw; apply and first activation ask again,
 * because a release can be deprecated, revoked, or quarantined between the approval and
 * the effect.
 */
export const assertNewInstallReleaseEligible = (
  release: EligibleAppRelease,
  runningRadiosoVersion: string | null,
): AdmittedManifest => assertReleaseUsable(
  release,
  runningRadiosoVersion,
  newInstallReleaseStates,
  "This release is no longer admitted, so it cannot be installed or activated.",
);

/**
 * Whether an installation that already exists may keep acting on its release. Every
 * release-dependent step of a reconfigure, an enable, a connection bind, and every
 * execution asks this rather than new-install eligibility.
 */
export const assertExistingInstallationReleaseUsable = (
  release: EligibleAppRelease,
  runningRadiosoVersion: string | null,
): AdmittedManifest => assertReleaseUsable(
  release,
  runningRadiosoVersion,
  existingInstallationReleaseStates,
  "This release has been withdrawn from use, so this installation cannot act on it.",
);

/**
 * The security decisions a release may move through, and only these.
 *
 * `revoked` is terminal: the whole point of revoking a release is that it stops running
 * everywhere, and an unconstrained state column would let a later `revoked -> deprecated`
 * put it back into the set of states that execute. Quarantine is the reversible one — it
 * is what an incident opens while the answer is still unknown — so it has an explicit,
 * audited way back to `admitted` or on to `deprecated`.
 */
const appReleaseSecurityTransitions: Readonly<Record<AppReleaseState, readonly AppReleaseState[]>> = {
  submitted: [],
  validating: [],
  admitted: ["deprecated", "revoked", "quarantined"],
  rejected: [],
  withdrawn: [],
  deprecated: ["revoked", "quarantined"],
  revoked: [],
  quarantined: ["admitted", "deprecated"],
};

/** The states a transition into `state` may legally start from. */
export const appReleaseSecuritySourceStates = (state: AppReleaseState): readonly AppReleaseState[] =>
  (Object.keys(appReleaseSecurityTransitions) as AppReleaseState[])
    .filter((from) => appReleaseSecurityTransitions[from].includes(state));

export const assertAppReleaseSecurityTransition = (from: AppReleaseState, to: AppReleaseState): void => {
  if (appReleaseSecurityTransitions[from].includes(to)) return;
  throw new AppsError(
    "invalid_release_transition",
    `A release cannot move from ${from} to ${to}.`,
    { from, to },
  );
};
