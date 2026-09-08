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
    // The default composition has no runtime provider at all, so activation would refuse.
    // The lifecycle surface needs one to be exercised end to end.
    appRuntimeProvisioning: {
      provision: async () => ({ ok: true as const }),
      deprovision: async () => ({ ok: true as const }),
    },
  });
  // Start-up admission, which `startApiRuntime` runs before the API listens.
  await harness.dependencies.appReleaseAdmissionService.syncBuiltInReleases();
  const session = await issueTestSession(harness.app);
  return { ...harness, session, headers: adminSessionHeaders(session) };
};

type Context = Awaited<ReturnType<typeof setup>>;

const plan = async (
  context: Context,
  releaseId: string,
  configuration: Record<string, unknown> = { site_url: "https://example.com" },
) => {
  const response = await request(context.app)
    .post("/api/v1/apps/installation-plans")
    .set(context.headers)
    .send({ releaseId, configuration })
    .expect(201);
  return response.body as { id: string; checksum: string; plan: Record<string, unknown> };
};

/** Apply, bind the release's required host-minted slot, then activate. */
const install = async (context: Context) => {
  const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
  const releaseId: string = releases.body.items[0].id;
  const approved = await plan(context, releaseId);
  const applied = await request(context.app)
    .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
    .set(context.headers)
    .send({ checksum: approved.checksum, expectedInstallationVersion: null, idempotencyKey: "install-1" })
    .expect(201);
  const installationId: string = applied.body.installation.id;

  const bound = await request(context.app)
    .post(`/api/v1/apps/installations/${installationId}/connections`)
    .set(context.headers)
    .send({ slotId: "webhook_secret", values: {}, expectedVersion: applied.body.installation.version })
    .expect(201);

  const view = await request(context.app)
    .get(`/api/v1/apps/installations/${installationId}`)
    .set(context.headers)
    .expect(200);
  const activated = await request(context.app)
    .post(`/api/v1/apps/installations/${installationId}/activate`)
    .set(context.headers)
    .send({ expectedVersion: view.body.installation.version })
    .expect(200);

  return { releaseId, approved, applied: applied.body, bound: bound.body, activated: activated.body };
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

    const approved = await plan(context, releases.body.items[0].id);

    expect(approved.checksum).toMatch(/^sha256:/);
    expect(approved.plan).toMatchObject({ appId: "ai.radioso.wordpress", version: "1.0.0" });
    expect(approved.plan.grants).toContainEqual({ kind: "permission", key: "documents.ingest" });
    expect(approved.plan.unresolvedRequirements).toEqual([
      expect.objectContaining({ code: "connection_unbound", path: "connections.slots.webhook_secret" }),
    ]);
  });

  // Release A attaches an App to a workspace; agent attachment arrives with tools. A
  // request that names target agents asks for authority this surface cannot grant.
  it("refuses a plan request that names target agents", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);

    await request(context.app)
      .post("/api/v1/apps/installation-plans")
      .set(context.headers)
      .send({
        releaseId: releases.body.items[0].id,
        configuration: { site_url: "https://example.com" },
        targetAgentIds: ["55555555-5555-4555-8555-555555555555"],
      })
      .expect(400);
  });

  it("reads an approved plan back for review", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
    const approved = await plan(context, releases.body.items[0].id);

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
    const approved = await plan(context, releases.body.items[0].id);

    const rejected = await request(context.app)
      .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
      .set(context.headers)
      .send({ checksum: "sha256:not-the-plan", expectedInstallationVersion: null, idempotencyKey: "install-1" })
      .expect(409);

    expect(rejected.body.error?.code ?? rejected.body.code).toBe("plan_stale");
  });

  it("applies a plan into a planned installation and activates it after setup", async () => {
    const context = await setup();

    const { applied, bound, activated } = await install(context);

    expect(applied.installation.state).toBe("planned");
    expect(applied.operation).toMatchObject({ kind: "install", state: "completed" });
    expect(bound.generatedSecret).toEqual(expect.any(String));
    expect(activated.installation.state).toBe("active");
    expect(activated.operation).toMatchObject({ kind: "activate", state: "completed", step: "activate" });

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

    expect(operations.body.items.map((operation: { kind: string }) => operation.kind))
      .toEqual(["activate", "install"]);
  });

  it("refuses activation while a required connection has no record", async () => {
    const context = await setup();
    const releases = await request(context.app).get("/api/v1/apps/releases").set(context.headers).expect(200);
    const approved = await plan(context, releases.body.items[0].id);
    const applied = await request(context.app)
      .post(`/api/v1/apps/installation-plans/${approved.id}/apply`)
      .set(context.headers)
      .send({ checksum: approved.checksum, expectedInstallationVersion: null, idempotencyKey: "install-1" })
      .expect(201);

    const refused = await request(context.app)
      .post(`/api/v1/apps/installations/${applied.body.installation.id}/activate`)
      .set(context.headers)
      .send({ expectedVersion: applied.body.installation.version })
      .expect(409);

    expect(refused.body.error?.code ?? refused.body.code).toBe("connections_unbound");
  });

  it("returns a minted connection secret once and never again", async () => {
    const context = await setup();
    const { applied, bound } = await install(context);

    const secret: string = bound.generatedSecret;
    expect(bound.connection).toMatchObject({ slotId: "webhook_secret", hasSecret: true });
    expect(JSON.stringify(bound.connection)).not.toContain(secret);

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${applied.installation.id}`)
      .set(context.headers)
      .expect(200);

    expect(JSON.stringify(view.body)).not.toContain(secret);
    expect(JSON.stringify(context.repositories.auditEventRepository.items)).not.toContain(secret);
  });

  it("keeps a sensitive connection field out of every readable surface", async () => {
    const context = await setup();
    const { activated } = await install(context);
    const installationId: string = activated.installation.id;

    const bound = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/connections`)
      .set(context.headers)
      .send({
        slotId: "site_credentials",
        values: { wp_username: "editor", wp_application_password: "correct horse battery staple" },
        expectedVersion: activated.installation.version,
      })
      .expect(201);

    expect(bound.body.generatedSecret).toBeNull();
    expect(bound.body.connection.publicFields).toEqual({ wp_username: "editor" });
    expect(JSON.stringify(bound.body)).not.toContain("correct horse battery staple");

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${installationId}`)
      .set(context.headers)
      .expect(200);

    expect(JSON.stringify(view.body)).not.toContain("correct horse battery staple");
  });

  it("refuses a connection slot the release does not declare", async () => {
    const context = await setup();
    const { activated } = await install(context);

    const refused = await request(context.app)
      .post(`/api/v1/apps/installations/${activated.installation.id}/connections`)
      .set(context.headers)
      .send({ slotId: "not_a_slot", values: {}, expectedVersion: activated.installation.version })
      .expect(400);

    expect(refused.body.error?.code ?? refused.body.code).toBe("connection_slot_unknown");
  });

  it("reconfigures under an optimistic version and refuses a stale one", async () => {
    const context = await setup();
    const { activated } = await install(context);
    const installationId: string = activated.installation.id;

    const updated = await request(context.app)
      .patch(`/api/v1/apps/installations/${installationId}/configuration`)
      .set(context.headers)
      .send({
        configuration: { site_url: "https://example.com", post_types: "page" },
        expectedVersion: activated.installation.version,
      })
      .expect(200);

    expect(updated.body.operation.kind).toBe("reconfigure");
    expect(updated.body.installation.configuration.post_types).toBe("page");

    await request(context.app)
      .patch(`/api/v1/apps/installations/${installationId}/configuration`)
      .set(context.headers)
      .send({
        configuration: { site_url: "https://example.com", post_types: "post" },
        expectedVersion: activated.installation.version,
      })
      .expect(409);
  });

  it("refuses a lifecycle command that carries no expected version", async () => {
    const context = await setup();
    const { activated } = await install(context);

    await request(context.app)
      .post(`/api/v1/apps/installations/${activated.installation.id}/disable`)
      .set(context.headers)
      .send({})
      .expect(400);
  });

  it("disables, enables, and removes an installation with a data disposition", async () => {
    const context = await setup();
    const { activated } = await install(context);
    const installationId: string = activated.installation.id;

    const disabled = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/disable`)
      .set(context.headers)
      .send({ expectedVersion: activated.installation.version })
      .expect(200);
    expect(disabled.body.installation.state).toBe("disabled");

    const enabled = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/enable`)
      .set(context.headers)
      .send({ expectedVersion: disabled.body.installation.version })
      .expect(200);
    expect(enabled.body.installation.state).toBe("active");

    const removed = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/remove`)
      .set(context.headers)
      .send({ disposition: "delete", expectedVersion: enabled.body.installation.version })
      .expect(200);
    expect(removed.body.installation.state).toBe("removed");

    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${installationId}`)
      .set(context.headers)
      .expect(200);
    expect(view.body.grants).toEqual([]);
  });

  it("fails activation with runtime_unavailable when no runtime provider is configured", async () => {
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
    const approved = await request(context.app)
      .post("/api/v1/apps/installation-plans")
      .set(headers)
      .send({ releaseId: releases.body.items[0].id, configuration: { site_url: "https://example.com" } })
      .expect(201);
    const applied = await request(context.app)
      .post(`/api/v1/apps/installation-plans/${approved.body.id}/apply`)
      .set(headers)
      .send({ checksum: approved.body.checksum, expectedInstallationVersion: null, idempotencyKey: "install-1" })
      .expect(201);
    const installationId: string = applied.body.installation.id;
    await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/connections`)
      .set(headers)
      .send({ slotId: "webhook_secret", values: {}, expectedVersion: applied.body.installation.version })
      .expect(201);
    const view = await request(context.app)
      .get(`/api/v1/apps/installations/${installationId}`)
      .set(headers)
      .expect(200);

    // Setting the App up is unaffected; only going live needs a runtime, and it says so.
    const activated = await request(context.app)
      .post(`/api/v1/apps/installations/${installationId}/activate`)
      .set(headers)
      .send({ expectedVersion: view.body.installation.version })
      .expect(200);

    expect(activated.body.installation.state).toBe("failed");
    expect(activated.body.operation.error.reason).toBe("runtime_unavailable");
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
