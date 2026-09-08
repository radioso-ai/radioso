import { describe, expect, it } from "vitest";

import { appManifestDigest } from "../../../src/modules/apps/public.js";
import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  createAppsHarness,
} from "./support.js";

/**
 * A host-minted secret is handed over on exactly one response, so a retry has to be
 * answerable without minting a second one — the first would already be stored somewhere
 * the operator cannot reach.
 */
describe("app connection bind idempotency", () => {
  it("answers an exact retry with the same connection and no second secret", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    const request = {
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-once",
      principal,
    };

    const first = await harness.connections.bind(request);
    expect(first.generatedSecret).toBeTruthy();
    expect(first.replayed).toBe(false);

    // The same request again — including the version the operator read, which the first
    // bind has already moved past.
    const replay = await harness.connections.bind(request);

    expect(replay.replayed).toBe(true);
    expect(replay.generatedSecret).toBeNull();
    expect(replay.connection.id).toBe(first.connection.id);
    expect(harness.repositories.connections.rows).toHaveLength(1);
    // Not a rotation: the stored ciphertext is still the one the operator was handed.
    expect(harness.repositories.connections.rows[0].secretCiphertext)
      .toBe(`enc(${first.generatedSecret})`);
  });

  it("refuses a key that was already used for a different bind", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "reused",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);

    await expect(harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "secret" },
      expectedVersion: current!.version,
      idempotencyKey: "reused",
      principal,
    })).rejects.toMatchObject({ reason: "idempotency_key_reused" });
  });

  it("refuses to bind against a release the host can no longer run", async () => {
    // The release was admitted when the installation was created and the host has since
    // moved to a version it does not support. Binding credentials to it would be storing
    // a credential for something that cannot execute.
    const harness = await createAppsHarness({ runningRadiosoVersion: "0.1.0" });
    const applied = await harness.apply();
    const release = await harness.repositories.releases.findById(applied.installation.candidateReleaseId!);
    const upstream = { ...release!.manifest, radiosoCompatibility: ">=99.0.0" };
    harness.repositories.releases.rows.set(release!.id, {
      ...release!,
      manifest: upstream,
      // The digest still describes the stored document, so this is a compatibility
      // refusal and not a stored-state integrity one.
      manifestDigest: appManifestDigest(upstream),
    });

    await expect(harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-incompatible",
      principal,
    })).rejects.toMatchObject({ reason: "release_not_eligible" });
  });
});
