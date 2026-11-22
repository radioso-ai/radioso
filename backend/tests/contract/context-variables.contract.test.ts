import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";
import {
  CONTEXT_VARIABLE_OPTION_KEY_PATTERN,
  deriveVisitorIdentitySigningKey,
} from "../../src/modules/context-variables/public.js";
import { conflict } from "../../src/shared/domain/errors.js";

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
  it("documents the conflict a value write returns when the stored value is kept", () => {
    const valueWrite = createOpenApiDocument().paths?.["/api/v1/context-variables/{id}/values"]?.put;

    expect(Object.keys(valueWrite?.responses ?? {})).toEqual(expect.arrayContaining(["200", "400", "401", "404", "409"]));
  });

  it("documents an option as the API takes it: the key pattern it enforces, and a description and archived flag a writer may leave out", () => {
    const schemas = createOpenApiDocument().components?.schemas ?? {};

    for (const name of ["ContextVariableOption", "ContextVariableOptionInput"]) {
      expect(schemas[name]).toMatchObject({ properties: { key: { pattern: CONTEXT_VARIABLE_OPTION_KEY_PATTERN.source } } });
    }
    expect(schemas.ContextVariableOptionInput).toMatchObject({ required: ["key", "label"] });
  });

  it("returns the existing typed conflict response when a pinned variable cannot be deleted", async () => {
    const { app, dependencies } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-delete-conflict@example.com");
    vi.spyOn(dependencies.contextVariableService, "delete")
      .mockRejectedValue(conflict("Cannot delete a context variable selected by an immutable agent revision"));

    await request(app)
      .delete("/api/v1/context-variables/11111111-1111-4111-8111-111111111111")
      .set("Authorization", `Bearer ${token}`)
      .expect(409)
      .expect({
        error: {
          code: "conflict",
          message: "Cannot delete a context variable selected by an immutable agent revision",
        },
      });
  });

  it("reveals the per-agent visitor identity signing key to workspace admins", async () => {
    const { app, dependencies } = createTestApp();
    const { cookie, token, workspaceId } = await issueTestToken(app, "context-vars-signing-key@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await createAgent(app, authorization);

    const response = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/context-variables/signing-key`)
      .set("Cookie", cookie)
      .set("X-Workspace-Id", workspaceId)
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
        source: "browser",
        surfacing: "always",
        enabled: true,
      })
      .expect(400);

    // visitor_request (source "request") resolves unconditionally from the conversation,
    // like the other built-ins — there is no agent_context_variables row to create for it.
    await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        source: "request",
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

  it("refuses an enablement for an agent from another workspace", async () => {
    const { app } = createTestApp();
    const first = await issueTestToken(app, "context-vars-foreign-agent-first@example.com");
    const second = await issueTestToken(app, "context-vars-foreign-agent-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;
    const agent = await createAgent(app, secondAuthorization);
    const variable = await createContextVariable(app, firstAuthorization);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", firstAuthorization)
      .send({ source: "pushed", surfacing: "always", enabled: true })
      .expect(404);
  });

  it("refuses an enablement whose resolver skill is not valid for the workspace agent", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-foreign-resolver@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await createAgent(app, authorization);
    const variable = await createContextVariable(app, authorization);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${variable.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send({
        source: "resolver",
        resolverSkillId: "11111111-1111-4111-8111-111111111111",
        surfacing: "always",
        enabled: true,
      })
      .expect(400);
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

    const stringVariable = await request(app)
      .post("/api/v1/context-variables")
      .set("Authorization", firstAuthorization)
      .send({
        name: "status",
        description: "Current status.",
        valueType: "string",
        trustTier: "unverified",
        sensitivity: "normal",
        defaultSurfacing: "always",
      })
      .expect(201);

    await request(app)
      .put(`/api/v1/context-variables/${stringVariable.body.contextVariable.id}/values`)
      .set("Authorization", firstAuthorization)
      .send({
        scope: { type: "session", id: "session-string" },
        data: { state: "not-a-string" },
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

  it("keeps an enum's options, archives rather than removes them, and takes only active keys as values", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-enum@example.com");
    const authorization = `Bearer ${token}`;
    const topic = {
      name: "topic",
      description: "What the conversation is about.",
      valueType: "enum",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    };

    await request(app).post("/api/v1/context-variables").set("Authorization", authorization).send(topic).expect(400);
    await request(app).post("/api/v1/context-variables").set("Authorization", authorization)
      .send({ ...topic, options: [{ key: "needs help", label: "Needs help" }] })
      .expect(400);

    const created = await request(app).post("/api/v1/context-variables").set("Authorization", authorization)
      .send({ ...topic, options: [{ key: "billing", label: "Billing", description: "Invoices and payments." }, { key: "shipping", label: "Shipping" }] })
      .expect(201);
    const id = created.body.contextVariable.id;
    expect(created.body.contextVariable.options).toEqual([
      { key: "billing", label: "Billing", description: "Invoices and payments.", archived: false },
      { key: "shipping", label: "Shipping", description: null, archived: false },
    ]);

    await request(app).patch(`/api/v1/context-variables/${id}`).set("Authorization", authorization)
      .send({ options: [{ key: "billing", label: "Billing" }] })
      .expect(400);
    const archived = await request(app).patch(`/api/v1/context-variables/${id}`).set("Authorization", authorization)
      .send({ options: [{ key: "billing", label: "Billing" }, { key: "shipping", label: "Shipping", archived: true }] })
      .expect(200);
    expect(archived.body.contextVariable.options[1]).toMatchObject({ key: "shipping", archived: true });

    const scope = { type: "session", id: "session-enum" };
    await request(app).put(`/api/v1/context-variables/${id}/values`).set("Authorization", authorization)
      .send({ scope, data: "shipping" })
      .expect(400);
    await request(app).put(`/api/v1/context-variables/${id}/values`).set("Authorization", authorization)
      .send({ scope, data: "billing" })
      .expect(200);
    await request(app).patch(`/api/v1/context-variables/${id}`).set("Authorization", authorization)
      .send({ valueType: "string" })
      .expect(409);
  });

  it("lets an agent classify a Choice attribute and refuses any other with the reason", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "context-vars-classified@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await createAgent(app, authorization);
    const topic = await request(app).post("/api/v1/context-variables").set("Authorization", authorization)
      .send({
        name: "topic", valueType: "enum", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
        options: [{ key: "billing", label: "Billing", description: "Invoices and payments." }],
      })
      .expect(201);
    const cart = await createContextVariable(app, authorization);
    const classify = { source: "classified", surfacing: "on_reference" };

    const enabled = await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${topic.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send(classify)
      .expect(200);
    expect(enabled.body.enablement).toMatchObject({ source: "classified", surfacing: "on_reference", enabled: true });

    const refused = await request(app)
      .put(`/api/v1/agents/${agent.body.id}/context-variables/${cart.body.contextVariable.id}`)
      .set("Authorization", authorization)
      .send(classify)
      .expect(400);
    expect(refused.body.error.message).toMatch(/Only a Choice \(enum\) attribute can use source "classified"/u);

    const madePrivate = await request(app).patch(`/api/v1/context-variables/${topic.body.contextVariable.id}`).set("Authorization", authorization)
      .send({ sensitivity: "sensitive" })
      .expect(400);
    expect(madePrivate.body.error.message).toMatch(/source "classified"/u);
  });

  it("writes a conversation's value and records which credential or teammate wrote it", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "context-vars-writer@example.com");
    const variable = await request(app).post("/api/v1/context-variables")
      .set("Cookie", session.cookie).set("X-Workspace-Id", session.workspaceId)
      .send({ name: "plan", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always" })
      .expect(201);
    const conversationId = "11111111-1111-4111-8111-111111111111";

    await request(app).put(`/api/v1/context-variables/${variable.body.contextVariable.id}/values`)
      .set("Cookie", session.cookie).set("X-Workspace-Id", session.workspaceId)
      .send({ scope: { type: "conversation", id: "not-a-conversation-id" }, data: "gold" })
      .expect(400);
    const put = await request(app).put(`/api/v1/context-variables/${variable.body.contextVariable.id}/values`)
      .set("Cookie", session.cookie).set("X-Workspace-Id", session.workspaceId)
      .send({ scope: { type: "conversation", id: conversationId }, data: "gold" })
      .expect(200);
    expect(put.body.value).toMatchObject({
      scope: { type: "conversation", id: conversationId },
      writtenBy: { kind: "api", ref: expect.any(String) },
    });

    // The same teammate through their API token: the credential, not the person, wrote it.
    const bearerPut = await request(app).put(`/api/v1/context-variables/${variable.body.contextVariable.id}/values`)
      .set("Authorization", `Bearer ${session.token}`)
      .send({ scope: { type: "conversation", id: conversationId }, data: "silver" })
      .expect(200);
    expect(bearerPut.body.value.writtenBy).toEqual({ kind: "api", ref: expect.any(String) });
    expect(bearerPut.body.value.writtenBy.ref).not.toBe(put.body.value.writtenBy.ref);

    const get = await request(app).get(`/api/v1/context-variables/${variable.body.contextVariable.id}/values`)
      .query({ scopeType: "conversation", scopeId: conversationId })
      .set("Authorization", `Bearer ${session.token}`)
      .expect(200);
    expect(get.body.value).toMatchObject({ data: "silver", writtenBy: bearerPut.body.value.writtenBy });
  });
});
