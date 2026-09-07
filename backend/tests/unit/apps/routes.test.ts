import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../../support/testApp.js";
import { wordpressArtifactCatalogue, wordpressManifestDocument } from "./support.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

const setup = async () => {
  const harness = createTestApp({
    envOverrides: { CONNECTOR_ENCRYPTION_KEY: encryptionKey },
    appBuiltInReleases: [{
      manifest: wordpressManifestDocument(),
      artifactDigests: [...wordpressArtifactCatalogue()],
    }],
    // The default composition has no runtime provider at all, so a hosted install would
    // stop at `provisioning`. The lifecycle surface needs one to be exercised end to end.
    appRuntimeProvisioning: { provision: async () => {}, deprovision: async () => {} },
  });
  // Start-up admission, which `startApiRuntime` runs before the API listens.
  await harness.dependencies.appReleaseAdmissionService.syncBuiltInReleases();
  const session = await issueTestSession(harness.app);
  return { ...harness, session, headers: adminSessionHeaders(session) };
};

const plan = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  headers: Record<string, string>,
  releaseId: string,
  configuration: Record<string, unknown> = { site_url: "https://example.com" },
) => {
  const response = await request(app)
    .post("/api/v1/apps/installation-plans")
    .set(headers)
    .send({ releaseId, configuration })
    .expect(201);
  return response.body as { id: string; checksum: string; plan: Record<string, unknown> };
};

const install = async (context: Awaited<ReturnType<typeof setup>>) => {
  const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
  const releaseId: string = releases.body.items[0].id;
  const approved = await plan(context.app, context.headers, releaseId);
  const applied = await request(context.app)
    .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
    .set(context.headers)
    .send({ checksum: approved.checksum, expectedInstallationVersion: null, idempotencyKey: "install-1" })
    .expect(201);
  return { releaseId, approved, applied: applied.body };
};

describe("app routes", () => {
  it("lists and inspects the releases admission has admitted", async () => {
    const context = await setup();

    const listed = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);

    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ appId: "ai.radioso.wordpress", version: "1.0.0" });

    const detail = await request(context.app)
      .get(`/api/v1/apps/releases/${listed.body.items[0].id}`)
      .set(context.headers)
      .expect(200);

    expect(detail.body.manifest.app.id).toBe("ai.radioso.wordpress");
    expect(detail.body.admissionPolicyVersion).toBe("release-a.1");
  });

  it("plans an installation and shows the operator what would be granted", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);

    const approved = await plan(context.app, context.headers, releases.body.items[0].id);

    expect(approved.checksum).toMatch(/^sha256:/);
    expect(approved.plan).toMatchObject({ appId: "ai.radioso.wordpress", version: "1.0.0" });
    expect(approved.plan.grants).toContainEqual({ kind: "permission", key: "documents.ingest" });
    expect(approved.plan.unresolvedRequirements).toEqual([]);
  });

  it("reads an approved plan back for review", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
    const approved = await plan(context.app, context.headers, releases.body.items[0].id);

    const reread = await request(context.app)
      .get(`/api/v1/apps/installation-plans/${approved.id}`)
      .set(context.headers)
      .expect(200);

    expect(reread.body.checksum).toBe(approved.checksum);
    expect(reread.body.consumedAt).toBeNull();
  });

  it("refuses an apply whose checksum no longer matches the approved plan", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
    const approved = await plan(context.app, context.headers, releases.body.items[0].id);

    const rejected = await request(context.app)
      .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
      .set(context.headers)
      .send({ checksum: "sha256:not-the-plan", expectedInstallationVersion: null, idempotencyKey: "install-1" })
      .expect(409);

    expect(rejected.body.error?.code ?? rejected.body.code).toBe("plan_stale");
  });

  it("applies a plan, activates the installation, and reports its lifecycle operations", async () => {
    const context = await setup();

    const { applied } = await install(context);

    expect(applied.installation.state).toBe("active");
    expect(applied.operation).toMatchObject({ kind: "install", state: "completed", step: "activate" });

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${applied.installation.id}`)
      .set(context.headers)
      .expect(200);

    expect(view.body.installation.state).toBe("active");
    expect(view.body.activeVersion).toBe("1.0.0");
    expect(view.body.grants.length).toBeGreaterThan(0);

    const operations = await request(context.app)
      .get(`/api/v1/apps/installations/${applied.installation.id}/operations`)
      .set(context.headers)
      .expect(200);

    expect(operations.body.items.map((operation: { kind: string }) => operation.kind)).toEqual(["install"]);
  });

  it("returns a minted connection secret once and never again", async () => {
    const context = await setup();
    const { applied } = await install(context);

    const bound = await request(context.app)
      .post(`/api/v1/apps/installations/${applied.installation.id}/connections`)
      .set(context.headers)
      .send({ slotId: "webhook_secret", values: {} })
      .expect(201);

    const secret: string = bound.body.generatedSecret;
    expect(secret).toEqual(expect.any(String));
    expect(bound.body.connection).toMatchObject({ slotId: "webhook_secret", hasSecret: true });
    expect(JSON.stringify(bound.body.connection)).not.toContain(secret);

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${applied.installation.id}`)
      .set(context.headers)
      .expect(200);

    expect(JSON.stringify(view.body)).not.toContain(secret);
    expect(JSON.stringify(context.repositories.auditEventRepository.items)).not.toContain(secret);
  });

  it("keeps a sensitive connection field out of every readable surface", async () => {
    const context = await setup();
    const { applied } = await install(context);

    const bound = await request(context.app)
      .post(`/api/v1/apps/installations/${applied.installation.id}/connections`)
      .set(context.headers)
      .send({
        slotId: "site_credentials",
        values: { wp_username: "editor", wp_application_password: "correct horse battery staple" },
      })
      .expect(201);

    expect(bound.body.generatedSecret).toBeNull();
    expect(bound.body.connection.publicFields).toEqual({ wp_username: "editor" });
    expect(JSON.stringify(bound.body)).not.toContain("correct horse battery staple");

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${applied.installation.id}`)
      .set(context.headers)
      .expect(200);

    expect(JSON.stringify(view.body)).not.toContain("correct horse battery staple");
  });

  it("refuses a connection slot the release does not declare", async () => {
    const context = await setup();
    const { applied } = await install(context);

    const refused = await request(context.app)
      .post(`/api/v1/apps/installations/${applied.installation.id}/connections`)
      .set(context.headers)
      .send({ slotId: "not_a_slot", values: {} })
      .expect(400);

    expect(refused.body.error?.code ?? refused.body.code).toBe("connection_slot_unknown");
  });

  it("updates configuration under an optimistic version and refuses a stale one", async () => {
    const context = await setup();
    const { applied } = await install(context);

    const updated = await request(context.app)
      .patch(`/api/v1/apps/installations/${applied.installation.id}/configuration`)
      .set(context.headers)
      .send({
        configuration: { site_url: "https://example.com", post_types: "page" },
        expectedVersion: applied.installation.version,
      })
      .expect(200);

    expect(updated.body.configuration.post_types).toBe("page");

    await request(context.app)
      .patch(`/api/v1/apps/installations/${applied.installation.id}/configuration`)
      .set(context.headers)
      .send({
        configuration: { site_url: "https://example.com", post_types: "post" },
        expectedVersion: applied.installation.version,
      })
      .expect(409);
  });

  it("disables, enables, and removes an installation with a data disposition", async () => {
    const context = await setup();
    const { applied } = await install(context);
    const installationId: string = applied.installation.id;

    const disabled = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/disable`)
      .set(context.headers)
      .send({})
      .expect(200);
    expect(disabled.body.installation.state).toBe("disabled");

    const enabled = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/enable`)
      .set(context.headers)
      .send({})
      .expect(200);
    expect(enabled.body.installation.state).toBe("active");

    const removed = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/remove`)
      .set(context.headers)
      .send({ disposition: "delete" })
      .expect(200);
    expect(removed.body.installation.state).toBe("removed");

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${installationId}`)
      .set(context.headers)
      .expect(200);
    expect(view.body.grants).toEqual([]);
  });

  it("reports an unconfigured runtime as a failed installation rather than a hung one", async () => {
    const context = createTestApp({
      envOverrides: { CONNECTOR_ENCRYPTION_KEY: encryptionKey },
      appBuiltInReleases: [{
        manifest: wordpressManifestDocument(),
        artifactDigests: [...wordpressArtifactCatalogue()],
      }],
    });
    await context.dependencies.appReleaseAdmissionService.syncBuiltInReleases();
    const session = await issueTestSession(context.app);
    const headers = adminSessionHeaders(session);

    const releases = await request(context.app).get("/api/v1/apps/releases").set(headers).expect(200);
    const approved = await plan(context.app, headers, releases.body.items[0].id);
    const applied = await request(context.app)
      .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
      .set(headers)
      .send({ checksum: approved.checksum, expectedInstallationVersion: null, idempotencyKey: "install-1" })
      .expect(201);

    expect(applied.body.installation.state).toBe("failed");
    expect(applied.body.operation.error.reason).toBe("runtime_unavailable");
  });

  it("refuses every apps route without a workspace session", async () => {
    const context = await setup();

    await request(context.app).get("/api/v1/apps/releases").expect(401);
    await request(context.app).get("/api/v1/apps/installations").expect(401);
  });

  it("refuses a machine credential: installing an App is an interactive administrator decision", async () => {
    const context = await setup();
    const { token, workspaceId } = await issueTestToken(context.app);

    await request(context.app)
      .get("/api/v1/apps/installations")
      .set({ Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId })
      .expect(401);
  });

});
