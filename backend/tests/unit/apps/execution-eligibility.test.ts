import { describe, expect, it } from "vitest";

import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  createAppsHarness,
  type AppsHarness,
} from "./support.js";

const activeInstallation = async (harness: AppsHarness) => (await harness.install()).installation;

/**
 * The Apps-owned execution decision every runtime path asks before it grants authority.
 * Each case here is a rule a caller would otherwise have had to reconstruct against Apps
 * persistence, which is exactly what architecture §5 puts on this side of the boundary.
 */
describe("app execution eligibility", () => {
  it("admits an active installation's granted, active contribution", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);

    const decision = await harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "site_content",
    });

    expect(decision).toMatchObject({ eligible: true });
    if (!decision.eligible) return;
    expect(decision.releaseDigest).toMatch(/^sha256:/);
    expect(decision.activeContributionIds).toContain("site_content");
  });

  it("refuses a contribution this configuration leaves switched off", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "content_poll",
    })).resolves.toEqual({ eligible: false, reason: "contribution_not_active" });
  });

  it("refuses everything for an installation that is not active", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);
    await harness.lifecycle.disable({
      workspaceId,
      installationId: installation.id,
      expectedVersion: installation.version,
      idempotencyKey: "disable-eligibility",
      principal,
    });

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "site_content",
    })).resolves.toEqual({ eligible: false, reason: "installation_not_active" });
  });

  it("refuses a contribution whose release has been revoked", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);
    await harness.releaseAdmission.transitionSecurityState(installation.activeReleaseId!, "revoked");

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "site_content",
    })).resolves.toEqual({ eligible: false, reason: "release_not_admitted" });
  });

  it("refuses a contribution the approved plan never granted", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "not_a_contribution",
    })).resolves.toEqual({ eligible: false, reason: "contribution_not_granted" });
  });

  it("refuses while a required connection is unbound", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);
    await harness.repositories.connections.markAllForDeletion(installation.id, new Date());

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "site_content",
    })).resolves.toEqual({ eligible: false, reason: "connections_unbound" });
  });

  it("refuses an installation it cannot find", async () => {
    const harness = await createAppsHarness();

    await expect(harness.eligibility.evaluate({
      installationId: "11111111-1111-4111-8111-111111111111",
      contributionId: "site_content",
    })).resolves.toEqual({ eligible: false, reason: "installation_not_found" });
  });

  it("fails closed when the decision cannot be established at all", async () => {
    const harness = await createAppsHarness();
    const installation = await activeInstallation(harness);
    harness.repositories.grants.listLive = async () => {
      throw new Error("the grant read timed out");
    };

    await expect(harness.eligibility.evaluate({
      installationId: installation.id,
      contributionId: "site_content",
    })).resolves.toEqual({ eligible: false, reason: "eligibility_unavailable" });
  });
});
