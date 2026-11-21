import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ApiRequestSender } from "../../src/modules/apiRequestSkills/public.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const CREDENTIAL = "token-abcdef-1234";

const createConnection = (app: Parameters<typeof request>[0], headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/v1/settings/api-connections")
    .set(headers)
    .send({
      name: "Orders API",
      baseUrl: "https://api.example.com/v1",
      authScheme: "bearer",
      credential: CREDENTIAL,
      defaultHeaders: { "X-Api-Version": "2024-01" },
      ...body,
    });

describe("settings API connections contract", () => {
  it("creates, reads, updates and deletes a connection without ever returning its credential", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "api-connections@example.com");
    const headers = adminSessionHeaders(session);

    const created = await createConnection(app, headers);
    expect(created.status).toBe(201);
    expect(created.body.connection).toEqual({
      id: expect.any(String),
      name: "Orders API",
      baseUrl: "https://api.example.com/v1",
      authScheme: "bearer",
      authHeaderName: null,
      credentialMask: "*************1234",
      defaultHeaders: { "X-Api-Version": "2024-01" },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const connectionId = created.body.connection.id as string;

    const list = await request(app).get("/api/v1/settings/api-connections").set(headers);
    expect(list.status).toBe(200);
    expect(list.body.connections).toHaveLength(1);
    const get = await request(app).get(`/api/v1/settings/api-connections/${connectionId}`).set(headers);
    expect(get.status).toBe(200);
    for (const body of [created.body, list.body, get.body]) {
      expect(JSON.stringify(body)).not.toContain(CREDENTIAL);
    }

    const renamed = await request(app)
      .patch(`/api/v1/settings/api-connections/${connectionId}`)
      .set(headers)
      .send({ name: "Orders API v2" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection).toMatchObject({ name: "Orders API v2", authScheme: "bearer", credentialMask: "*************1234" });

    const switched = await request(app)
      .patch(`/api/v1/settings/api-connections/${connectionId}`)
      .set(headers)
      .send({ authScheme: "header", authHeaderName: "X-Api-Key", credential: "key-9876" });
    expect(switched.status).toBe(200);
    expect(switched.body.connection).toMatchObject({ authScheme: "header", authHeaderName: "X-Api-Key", credentialMask: "****9876" });

    const unauthenticated = await request(app)
      .patch(`/api/v1/settings/api-connections/${connectionId}`)
      .set(headers)
      .send({ authScheme: "none" });
    expect(unauthenticated.status).toBe(200);
    expect(unauthenticated.body.connection).toMatchObject({ authScheme: "none", authHeaderName: null, credentialMask: null });

    const deleted = await request(app).delete(`/api/v1/settings/api-connections/${connectionId}`).set(headers);
    expect(deleted.status).toBe(204);
    expect((await request(app).get(`/api/v1/settings/api-connections/${connectionId}`).set(headers)).status).toBe(404);
  });

  it("masks a basic credential as its username alone, showing nothing of the password", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "api-connections-basic@example.com");
    const headers = adminSessionHeaders(session);

    const created = await createConnection(app, headers, { authScheme: "basic", credential: "ada:s3cretpass-7781" });

    expect(created.status).toBe(201);
    expect(created.body.connection.credentialMask).toBe("ada:****");
    expect(JSON.stringify(created.body)).not.toContain("7781");
  });

  it("asks for the credential again when a patch would send the stored one somewhere else", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "api-connections-retarget@example.com");
    const headers = adminSessionHeaders(session);
    const connectionId = (await createConnection(app, headers)).body.connection.id as string;
    const patch = (body: Record<string, unknown>) =>
      request(app).patch(`/api/v1/settings/api-connections/${connectionId}`).set(headers).send(body);

    for (const body of [
      { baseUrl: "https://attacker.example/v1" },
      { authScheme: "basic" },
      { authScheme: "header", authHeaderName: "X-Api-Key" },
    ]) {
      const refused = await patch(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "credential_required" });
    }

    expect((await patch({ baseUrl: "https://api.example.com/v2" })).status).toBe(200);
    expect((await patch({ authScheme: "header", authHeaderName: "X-Api-Key", credential: "key-1234" })).status).toBe(200);
    const renamedHeader = await patch({ authHeaderName: "X-Other-Key" });
    expect(renamedHeader.status).toBe(400);
    expect(renamedHeader.body.error).toMatchObject({ code: "credential_required" });
    expect((await patch({ baseUrl: "https://elsewhere.example", credential: "key-5678" })).status).toBe(200);
    expect((await patch({ authScheme: "none" })).status).toBe(200);
  });

  it("refuses a duplicate name, a plain-http or query-carrying base URL, a missing credential, and a malformed id", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "api-connections-invalid@example.com");
    const headers = adminSessionHeaders(session);

    expect((await createConnection(app, headers)).status).toBe(201);
    expect((await createConnection(app, headers, { name: "orders api" })).status).toBe(409);
    expect((await createConnection(app, headers, { name: "Plain", baseUrl: "http://api.example.com" })).status).toBe(400);
    expect((await createConnection(app, headers, { name: "Query", baseUrl: "https://api.example.com/v1?key=1" })).status).toBe(400);
    expect((await createConnection(app, headers, { name: "No credential", credential: undefined })).status).toBe(400);
    expect((await createConnection(app, headers, { name: "Cookie", defaultHeaders: { Cookie: "a=b" } })).status).toBe(400);
    expect((await request(app).get("/api/v1/settings/api-connections/not-a-uuid").set(headers)).status).toBe(400);
  });

  it("keeps a connection a skill targets, naming the skill", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "api-connections-in-use@example.com");
    const headers = adminSessionHeaders(session);
    const agentId = (await request(app).get("/api/v1/agents").set(headers)).body.agents[0].id as string;
    const connectionId = (await createConnection(app, headers)).body.connection.id as string;

    const capabilities = await request(app).get(`/api/v1/agents/${agentId}/skill-capabilities`).set(headers);
    expect(capabilities.body.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "api_request",
        storedKind: "api_request",
        targetKind: "api_connection",
        available: true,
        supportedInvocationModes: ["routine_named"],
        targets: [expect.objectContaining({ id: connectionId, label: "Orders API" })],
      }),
    ]));

    const skill = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "order_status",
        capability: "api_request",
        target: { kind: "api_connection", id: connectionId },
        config: { method: "GET", path: "/orders/{order_number}", exposedParams: { order_number: { type: "text" } } },
        invocationMode: "routine_named",
      });
    expect(skill.status).toBe(201);
    expect(skill.body.skill).toMatchObject({ capability: "api_request", storedKind: "api_request", target: { kind: "api_connection", id: connectionId } });

    const selectable = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "order_status_tool",
        capability: "api_request",
        target: { kind: "api_connection", id: connectionId },
        config: { method: "GET", path: "/orders" },
        invocationMode: "agent_selectable",
      });
    expect(selectable.status).toBe(400);

    const blocked = await request(app).delete(`/api/v1/settings/api-connections/${connectionId}`).set(headers);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "api_connection_in_use" });
    expect(JSON.stringify(blocked.body)).toContain("skill:order_status");
  });

  it("sends a test request through the connection and returns the outcome, the declared outputs and the body", async () => {
    const sender = vi.fn<ApiRequestSender>(async () => ({
      kind: "response",
      status: 200,
      body: Buffer.from(JSON.stringify({ order: { status: "shipped" }, items: [{ title: "Lamp" }] })),
      contentType: "application/json",
      durationMs: 42,
    }));
    const { app } = createTestApp({ apiRequestSender: sender });
    const session = await issueTestSession(app, "api-connections-test-request@example.com");
    const headers = adminSessionHeaders(session);
    const connectionId = (await createConnection(app, headers)).body.connection.id as string;

    const tested = await request(app)
      .post(`/api/v1/settings/api-connections/${connectionId}/test-request`)
      .set(headers)
      .send({
        method: "GET",
        path: "/orders/{order_number}",
        exposedSampleValues: { order_number: "A-100" },
        outputs: {
          order_status: { path: "order.status", type: "text", required: true },
          carrier: { path: "order.carrier", type: "text" },
        },
      });

    expect(tested.status).toBe(200);
    expect(tested.body).toEqual({
      httpStatus: 200,
      durationMs: 42,
      outcome: "completed",
      outputs: { order_status: "shipped" },
      mismatches: [],
      body: { order: { status: "shipped" }, items: [{ title: "Lamp" }] },
      bodyTruncated: false,
    });
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][0]).toMatchObject({
      method: "GET",
      url: "https://api.example.com/v1/orders/A-100",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
  });

  it("names the required outputs a test response leaves absent", async () => {
    const sender = vi.fn<ApiRequestSender>(async () => ({
      kind: "response",
      status: 200,
      body: Buffer.from(JSON.stringify({ order: {} })),
      contentType: "application/json",
      durationMs: 5,
    }));
    const { app } = createTestApp({ apiRequestSender: sender });
    const session = await issueTestSession(app, "api-connections-mismatch@example.com");
    const headers = adminSessionHeaders(session);
    const connectionId = (await createConnection(app, headers)).body.connection.id as string;

    const tested = await request(app)
      .post(`/api/v1/settings/api-connections/${connectionId}/test-request`)
      .set(headers)
      .send({ method: "GET", path: "/orders", outputs: { order_status: { path: "order.status", type: "text", required: true } } });

    expect(tested.body).toMatchObject({ outcome: "failed", reason: "response_mismatch", mismatches: ["order_status"], body: { order: {} } });
  });

  it("requires a signed-in teammate", async () => {
    const { app } = createTestApp();
    expect((await request(app).get("/api/v1/settings/api-connections")).status).toBe(401);

    const { token } = await issueTestToken(app, "api-connections-machine@example.com");
    const machine = await request(app).get("/api/v1/settings/api-connections").set("Authorization", `Bearer ${token}`);
    expect([401, 403]).toContain(machine.status);
  });
});
