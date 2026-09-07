import { describe, expect, it } from "vitest";

import {
  APP_ADMISSION_POLICY_VERSION,
  admitAppRelease,
  appManifestDigest,
} from "../../../src/modules/apps/public.js";
import { wordpressArtifactCatalogue, wordpressManifestDocument } from "./support.js";

describe("app release admission", () => {
  it("admits the reference manifest under the Release A policy and records the policy version", () => {
    const decision = admitAppRelease({
      manifest: wordpressManifestDocument(),
      artifactCatalogue: wordpressArtifactCatalogue(),
    });

    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.policyVersion).toBe(APP_ADMISSION_POLICY_VERSION);
    expect(decision.provenance).toEqual({ kind: "built_in_registry" });
    expect(decision.manifest.app.id).toBe("ai.radioso.wordpress");
    expect(decision.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decision.artifactDigest).toBe(decision.manifest.artifact.digest);
  });

  it("summarises evidence as counts and never copies manifest content into the decision", () => {
    const decision = admitAppRelease({
      manifest: wordpressManifestDocument(),
      artifactCatalogue: wordpressArtifactCatalogue(),
    });

    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.evidence).toEqual({
      contributionCount: 3,
      permissionCount: 5,
      destinationCount: 1,
      storageCollectionCount: 1,
      connectionSlotCount: 2,
      verifiedDigestCount: 2,
    });
    expect(JSON.stringify(decision.evidence)).not.toContain("wordpress");
  });

  it("digests a manifest by canonical content, not by key order", () => {
    const document = wordpressManifestDocument();
    const reordered = Object.fromEntries(Object.entries(document).reverse());

    expect(appManifestDigest(reordered)).toBe(appManifestDigest(document));
  });

  it("rejects a manifest whose artifact digest the registry does not vouch for", () => {
    const decision = admitAppRelease({
      manifest: wordpressManifestDocument(),
      artifactCatalogue: new Set<string>(),
    });

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

    const decision = admitAppRelease({ manifest: document, artifactCatalogue: wordpressArtifactCatalogue() });

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues.length).toBeGreaterThan(0);
  });

  it("rejects re-admitting the same version with different content", () => {
    const original = wordpressManifestDocument();
    const changed = {
      ...original,
      app: { ...(original.app as Record<string, unknown>), description: "Rewritten after publication." },
    };

    const decision = admitAppRelease({
      manifest: changed,
      artifactCatalogue: wordpressArtifactCatalogue(),
      admittedManifestDigest: appManifestDigest(original),
    });

    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.issues).toContainEqual(
      expect.objectContaining({ code: "release_version_immutable", path: "version" }),
    );
  });

  it("re-admits an unchanged version idempotently", () => {
    const document = wordpressManifestDocument();

    const decision = admitAppRelease({
      manifest: document,
      artifactCatalogue: wordpressArtifactCatalogue(),
      admittedManifestDigest: appManifestDigest(document),
    });

    expect(decision.outcome).toBe("admitted");
  });
});
