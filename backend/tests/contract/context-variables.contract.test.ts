import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";
import { deriveVisitorIdentitySigningKey } from "../../src/modules/context-variables/public.js";

const createAgent = async (app: ReturnType<typeof createTestApp>["app"], authorization: string) =>
  request(app)
    .post("/api/v1/agents")
    .set("Authorization", authorization)
    .send({ name: "Context variable agent" })
    .expect(201);

const createContextVariable = async (app: ReturnType<typeof createTestApp>["app"], authorization: string) =>
  request(app)
    .post("/api/v1/context-variables")
    .set("Authorization", authorization)
    .send({
      name: "cart",
      description: "Current cart contents.",
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    })
    .expect(201);

describe("context variable HTTP API", () => {
  it("reveals the per-agent visitor identity signing key to workspace admins", async () => {
    const { app, dependencies } = createTestApp();
    const { token, workspaceId } = await issueTestToken(app, "context-vars-signing-key@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await createAgent(app, authorization);

    const response = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/context-variables/signing-key`)
      .set("Authorization", authorization)
      .expect(200);

    expect(response.body).toEqual({
      signingKey: deriveVisitorIdentitySigningKey(
        dependencies.env.WORKSPACE_TOKEN_SECRET!,
        workspaceId,
        agent.body.id,
      ).toString("hex"),
    });
  });

  it("manages workspace context variable declarations", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-catalog@example.com");
    const authorization = `Bearer ${token}`;

    const create = await createContextVariable(app, authorization);

    expect(create.body.contextVariable).toMatchObject({
      id: expect.any(String),
      name: "cart",
      description: "Current cart contents.",
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const get = await request(app)
      .get(`/api/v1/context-variables/${create.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .expect(200);
    expect(get.body.contextVariable).toMatchObject({ id: create.body.contextVariable.id, name: "cart" });

    const list = await request(app)
      .get("/api/v1/context-variables")
      .set("Authorization", authorization)
      .expect(200);
    expect(list.body.contextVariables).toEqual([
      expect.objectContaining({ id: create.body.contextVariable.id, name: "cart" }),
    ]);

    const patch = await request(app)
      .patch(`/api/v1/context-variables/${create.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        description: "Latest cart snapshot.",
        defaultSurfacing: "on_reference",
      })
      .expect(200);
    expect(patch.body.contextVariable).toMatchObject({
      id: create.body.contextVariable.id,
      description: "Latest cart snapshot.",
      defaultSurfacing: "on_reference",
    });

    await request(app)
      .delete(`/api/v1/context-variables/${create.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .expect(204);

    await request(app)
      .get(`/api/v1/context-variables/${create.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .expect(404);
  });

  it("manages per-agent context variable enablements and returns clean resolver validation errors", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-enablements@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await createAgent(app, authorization);
    const variable = await createContextVariable(app, authorization);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        source: "resolver",
        surfacing: "always",
        enabled: true,
      })
      .expect(400);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        source: "pushed",
        maxAgeSeconds: 60,
        surfacing: "always",
        enabled: true,
      })
      .expect(400);

    const upsert = await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        source: "pushed",
        surfacing: "operator_only",
        enabled: true,
      })
      .expect(200);

    expect(upsert.body.enablement).toMatchObject({
      agentId: agent.body.id,
      variableId: variable.body.contextVariable.id,
      source: "pushed",
      resolverSkillId: null,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "operator_only",
      enabled: true,
    });

    const list = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/context-variables`)
      .set("Authorization", authorization)
      .expect(200);
    expect(list.body.enablements).toEqual([
      expect.objectContaining({
        id: upsert.body.enablement.id,
        variable: expect.objectContaining({ id: variable.body.contextVariable.id, name: "cart" }),
      }),
    ]);

    await request(app)
      .delete(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .expect(204);

    await request(app)
      .delete(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .expect(404);
  });

  it("manages pushed values and rejects oversized or cross-workspace value access", async () => {
    const { app } = createTestApp();
    const first = await issueTestToken(app, "context-vars-values-first@example.com");
    const second = await issueTestToken(app, "context-vars-values-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;
    const variable = await createContextVariable(app, firstAuthorization);
    const variableId = variable.body.contextVariable.id;

    await request(app)
      .put(`/api/v1/context-variables/${variableId}/values`)
      .set("Authorization", secondAuthorization)
      .send({
        scope: { type: "session", id: "session-1" },
        data: { lineItems: [] },
      })
      .expect(404);

    await request(app)
      .put(`/api/v1/context-variables/${variableId}/values`)
      .set("Authorization", firstAuthorization)
      .send({
        scope: { type: "session", id: "session-oversized" },
        data: "x".repeat(33 * 1024),
      })
      .expect(400);

    const put = await request(app)
      .put(`/api/v1/context-variables/${variableId}/values`)
      .set("Authorization", firstAuthorization)
      .send({
        scope: { type: "session", id: "session-1" },
        data: { lineItems: [{ sku: "sku_123", quantity: 2 }] },
      })
      .expect(200);

    expect(put.body.value).toMatchObject({
      id: expect.any(String),
      variableId,
      workspaceId: first.workspaceId,
      scope: { type: "session", id: "session-1" },
      data: { lineItems: [{ sku: "sku_123", quantity: 2 }] },
      lastModified: expect.any(String),
    });

    const get = await request(app)
      .get(`/api/v1/context-variables/${variableId}/values`)
      .query({ scopeType: "session", scopeId: "session-1" })
      .set("Authorization", firstAuthorization)
      .expect(200);
    expect(get.body.value).toMatchObject({ id: put.body.value.id, data: put.body.value.data });

    await request(app)
      .get(`/api/v1/context-variables/${variableId}/values`)
      .query({ scopeType: "session", scopeId: "session-1" })
      .set("Authorization", secondAuthorization)
      .expect(404);

    await request(app)
      .delete(`/api/v1/context-variables/${variableId}/values`)
      .set("Authorization", firstAuthorization)
      .send({ scope: { type: "session", id: "session-1" } })
      .expect(204);

    await request(app)
      .get(`/api/v1/context-variables/${variableId}/values`)
      .query({ scopeType: "session", scopeId: "session-1" })
      .set("Authorization", firstAuthorization)
      .expect(404);
  });
});
