import { describe, expect, it } from "vitest";

import {
  APP_ADMISSION_POLICY_VERSION,
  AppReleaseAdmissionService,
  admitAppRelease,
  appManifestDigest,
} from "../../../src/modules/apps/public.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import { admittedManifestOf } from "../../../src/modules/apps/domain/releaseAdmission.js";
import {
  APPS_TEST_PRINCIPAL,
  RUNNING_RADIOSO_VERSION,
  createAppsHarness,
  wordpressArtifactCatalogue,
  wordpressManifest,
  wordpressManifestDocument,
} from "./support.js";

const admissionInput = (overrides: Partial<Parameters<typeof admitAppRelease>[0]> = {}) => ({
  manifest: wordpressManifestDocument(),
  artifactCatalogue: wordpressArtifactCatalogue(),
  runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  ...overrides,
});

describe("app release admission", () => {
  it("admits the reference manifest under the Release A policy and records the policy version", () => {
    const decision = admitAppRelease(admissionInput());

    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.policyVersion).toBe(APP_ADMISSION_POLICY_VERSION);
    expect(decision.manifest.app.id).toBe("ai.radioso.wordpress");
    expect(decision.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decision.artifactDigest).toBe(decision.manifest.artifact.digest);
  });

  /**
   * The evidence record says what Release A actually established and, just as
   * importantly, what it did not. A decision that simply omitted the checks it never ran
   * would read later as though they had passed.
   */
  it("records what was established and names every check it did not run", () => {
    const decision = admitAppRelease(admissionInput());

    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.evidence).toEqual({
      signature: "not_evaluated",
      provenance: "not_evaluated",
      softwareInventory: "not_evaluated",
      vulnerabilityPolicy: "not_evaluated",
      conformance: "not_evaluated",
      compatibility: {
        runningVersion: RUNNING_RADIOSO_VERSION,
        range: wordpressManifest().radiosoCompatibility,
        result: "compatible",
      },
      contributionCount: 3,
      permissionCount: 5,
      destinationCount: 1,
      storageCollectionCount: 1,
      connectionSlotCount: 2,
      verifiedDigestCount: 2,
      trustRoot: "built_in_registry",
    });
    expect(JSON.stringify(decision.evidence)).not.toContain("wordpress");
  });

  it("digests a manifest by canonical content, not by key order", () => {
    const document = wordpressManifestDocument();
    const reordered = Object.fromEntries(Object.entries(document).reverse());

    expect(appManifestDigest(reordered)).toBe(appManifestDigest(document));
  });

  it("rejects a manifest whose artifact digest the registry does not vouch for", () => {
    const decision = admitAppRelease(admissionInput({ artifactCatalogue: new Set<string>() }));

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.policyVersion).toBe(APP_ADMISSION_POLICY_VERSION);
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "artifact_digest_not_in_catalogue", path: "artifact.digest" }),
    );
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "artifact_digest_not_in_catalogue", path: "companionAssets[0].digest" }),
    );
  });

  it("rejects a manifest the Release A contract policy refuses", () => {
    const document = wordpressManifestDocument();
    const contributions = document.contributions as Array<Record<string, unknown>>;
    contributions[1] = { ...contributions[1], kind: "tool" };

    const decision = admitAppRelease(admissionInput({ manifest: document }));

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues.length).toBeGreaterThan(0);
  });

  it("rejects a release that does not support the Radioso version this host runs", () => {
    const document = { ...wordpressManifestDocument(), radiosoCompatibility: ">=9.0.0" };

    const decision = admitAppRelease(admissionInput({ manifest: document }));

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "radioso_version_incompatible", path: "radiosoCompatibility" }),
    );
  });

  it("fails closed when the host cannot determine which Radioso version it runs", () => {
    const decision = admitAppRelease(admissionInput({ runningRadiosoVersion: null }));

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "radioso_version_undetermined" }),
    );
  });
});

describe("app release version immutability", () => {
  const changedManifest = () => {
    const original = wordpressManifestDocument();
    return {
      ...original,
      app: { ...(original.app as Record<string, unknown>), description: "Rewritten after publication." },
    };
  };

  it("rejects re-admitting a version whose recorded content differs", () => {
    const decision = admitAppRelease(admissionInput({
      manifest: changedManifest(),
      recordedManifestDigest: appManifestDigest(wordpressManifest()),
    }));

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "release_version_immutable", path: "version" }),
    );
  });

  it("re-admits an unchanged version idempotently", () => {
    const decision = admitAppRelease(admissionInput({
      recordedManifestDigest: appManifestDigest(wordpressManifest()),
    }));

    expect(decision.outcome).toBe("admitted");
  });

  // Immutability is a property of the version, not of the admitted state. Comparing only
  // against an admitted row would let changed content in under a version that had been
  // deprecated, revoked, or quarantined.
  it.each(["admitted", "deprecated", "revoked", "quarantined"] as const)(
    "keeps a %s release's stored content unchanged when the registry ships a different build",
    async (state) => {
      const harness = await createAppsHarness();
      const releaseId = await harness.admitReference();
      const original = await harness.repositories.releases.findById(releaseId);
      await harness.repositories.releases.transitionState(releaseId, state);

      const registry = new AppReleaseAdmissionService({
        releases: harness.repositories.releases,
        unitOfWork: { run: async (work) => work(harness.repositories) },
        builtInReleases: [{
          manifest: changedManifest(),
          artifactDigests: [...wordpressArtifactCatalogue()],
        }],
        auditDelivery: { drain: async () => 0 },
        logger: createLogger("silent"),
        runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
      });
      await registry.syncBuiltInReleases();

      const stored = await harness.repositories.releases.findById(releaseId);
      expect(stored?.state).toBe(state);
      expect(stored?.manifestDigest).toBe(original?.manifestDigest);
      expect(stored?.manifest.app.description).toBe(original?.manifest.app.description);
    },
  );
});

describe("app release registry synchronisation", () => {
  it("never resurrects a revoked release when the platform restarts", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    await harness.releaseAdmission.transitionSecurityState({ releaseId, state: "revoked", ...APPS_TEST_PRINCIPAL, actorUserId: APPS_TEST_PRINCIPAL.userId, reason: "test revocation" });

    await harness.releaseAdmission.syncBuiltInReleases();

    const release = await harness.repositories.releases.findById(releaseId);
    expect(release?.state).toBe("revoked");
    expect(await harness.releaseAdmission.listInstallable()).toEqual([]);
  });

  it("audits an explicit security-state transition", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();

    await harness.releaseAdmission.transitionSecurityState({ releaseId, state: "quarantined", ...APPS_TEST_PRINCIPAL, actorUserId: APPS_TEST_PRINCIPAL.userId, reason: "test quarantine" });

    const events = harness.audit.record.mock.calls.map((call) => (call[0] as { eventType: string }).eventType);
    expect(events).toContain("app.release.quarantined");
  });
});

describe("re-admitting a stored manifest", () => {
  it("refuses a stored manifest whose content no longer matches its recorded digest", () => {
    const manifest = wordpressManifest();

    expect(() => admittedManifestOf({
      manifest: { ...manifest, app: { ...manifest.app, description: "Edited in place." } },
      manifestDigest: appManifestDigest(manifest),
      admissionPolicyVersion: APP_ADMISSION_POLICY_VERSION,
    })).toThrowError(expect.objectContaining({
      reason: "release_not_admitted",
      details: { cause: "manifest_digest_mismatch" },
    }));
  });

  it("accepts a stored manifest that still matches the digest admission recorded", () => {
    const manifest = wordpressManifest();

    expect(admittedManifestOf({
      manifest,
      manifestDigest: appManifestDigest(manifest),
      admissionPolicyVersion: APP_ADMISSION_POLICY_VERSION,
    }).app.id).toBe("ai.radioso.wordpress");
  });
});

describe("current release eligibility", () => {
  it("refuses to plan against a release that is no longer admitted", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    await harness.releaseAdmission.transitionSecurityState({ releaseId, state: "revoked", ...APPS_TEST_PRINCIPAL, actorUserId: APPS_TEST_PRINCIPAL.userId, reason: "test revocation" });

    await expect(harness.plans.create({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      releaseId,
      configuration: { site_url: "https://example.com" },
      principal: { accountId: "33333333-3333-4333-8333-333333333333", userId: "44444444-4444-4444-8444-444444444444" },
    })).rejects.toMatchObject({ reason: "release_not_eligible" });
  });

  it("refuses to apply an approved plan whose release was revoked in the meantime", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const principal = {
      accountId: "33333333-3333-4333-8333-333333333333",
      userId: "44444444-4444-4444-8444-444444444444",
    };
    const plan = await harness.plans.create({
      workspaceId,
      releaseId,
      configuration: { site_url: "https://example.com" },
      principal,
    });
    await harness.releaseAdmission.transitionSecurityState({ releaseId, state: "revoked", ...APPS_TEST_PRINCIPAL, actorUserId: APPS_TEST_PRINCIPAL.userId, reason: "test revocation" });

    await expect(harness.lifecycle.apply({
      workspaceId,
      planId: plan.id,
      checksum: plan.checksum,
      expectedInstallationVersion: null,
      idempotencyKey: "install-revoked",
      principal,
    })).rejects.toMatchObject({ reason: "release_not_eligible" });

    // Nothing was consumed or created, so the approval can be re-reviewed once the
    // release is eligible again.
    expect(harness.repositories.installations.rows.size).toBe(0);
    expect([...harness.repositories.plans.rows.values()][0]?.consumedAt).toBeNull();
  });

  it("refuses a resumed activation whose release was revoked mid-operation", async () => {
    const harness = await createAppsHarness();
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const principal = {
      accountId: "33333333-3333-4333-8333-333333333333",
      userId: "44444444-4444-4444-8444-444444444444",
    };
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      principal,
    });
    await harness.releaseAdmission.transitionSecurityState({ releaseId: applied.installation.candidateReleaseId!, state: "quarantined", ...APPS_TEST_PRINCIPAL, actorUserId: APPS_TEST_PRINCIPAL.userId, reason: "test quarantine" });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);

    await expect(harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-quarantined",
      principal,
    })).rejects.toMatchObject({ reason: "release_not_eligible" });
    expect(harness.provisioning.provision).not.toHaveBeenCalled();
  });
});
