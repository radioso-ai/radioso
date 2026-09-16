import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("unified agent skills contract", () => {
  it("projects skill capabilities including unavailable capabilities", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-skill-capabilities@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;

    const capabilities = await request(app).get(`/api/v1/agents/${agentId}/skill-capabilities`).set(headers);

    expect(capabilities.status).toBe(200);
    expect(capabilities.body.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "webhook_call",
        storedKind: "webhook",
        targetKind: "webhook_destination",
        available: false,
        unavailableReason: "no_connection",
        targets: [],
      }),
      expect.objectContaining({
        id: "email",
        storedKind: "customer_email",
        available: false,
        unavailableReason: "no_connection",
      }),
    ]));
  });

  it("creates, lists, updates, and deletes skills through the uniform envelope", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-skills@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;

    const destination = await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "crm-leads", url: "https://hooks.example.com/leads" });
    expect(destination.status).toBe(201);
    const destinationId = destination.body.destination.id as string;

    const capabilities = await request(app).get(`/api/v1/agents/${agentId}/skill-capabilities`).set(headers);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "webhook_call",
        available: true,
        targets: [expect.objectContaining({ id: destinationId, label: "crm-leads" })],
      }),
    ]));

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "send_lead_webhook",
        capability: "webhook_call",
        target: { kind: "webhook_destination", id: destinationId },
        config: {
          boundPayload: { source: "routine" },
          exposedPayload: {
            email: { slotBinding: "customerEmail" },
          },
        },
        invocationMode: "routine_named",
        enabled: true,
      });

    expect(created.status).toBe(201);
    expect(created.body.skill).toMatchObject({
      id: expect.any(String),
      name: "send_lead_webhook",
      capability: "webhook_call",
      storedKind: "webhook",
      target: { kind: "webhook_destination", id: destinationId },
      invocationMode: "routine_named",
      enabled: true,
    });

    const listed = await request(app).get(`/api/v1/agents/${agentId}/skills`).set(headers);
    expect(listed.status).toBe(200);
    // Every agent carries its own default-answer retrieve skill ("answer") alongside
    // whatever else it has been given.
    expect(listed.body.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.skill.id, name: "send_lead_webhook" }),
      expect.objectContaining({ name: "answer", capability: "retrieve", invocationMode: "default_answer" }),
    ]));
    expect(listed.body.skills).toHaveLength(2);

    const duplicate = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "send_lead_webhook",
        capability: "webhook_call",
        target: { kind: "webhook_destination", id: destinationId },
        config: { boundPayload: {}, exposedPayload: {} },
        invocationMode: "routine_named",
      });
    expect(duplicate.status).toBe(409);

    const updated = await request(app)
      .patch(`/api/v1/agents/${agentId}/skills/${created.body.skill.id}`)
      .set(headers)
      .send({
        enabled: false,
        invocationMode: "agent_selectable",
        config: {
          boundPayload: { source: "routine-v2" },
        },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.skill).toMatchObject({
      enabled: false,
      invocationMode: "agent_selectable",
      config: {
        boundPayload: { source: "routine-v2" },
        exposedPayload: {
          email: { slotBinding: "customerEmail" },
        },
      },
    });

    const removed = await request(app)
      .delete(`/api/v1/agents/${agentId}/skills/${created.body.skill.id}`)
      .set(headers);
    expect(removed.status).toBe(204);
  });

  it("creates retrieve skills with source scope config and no synthetic target id", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "agent-retrieve-skills@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;
    const source = await dependencies.documentSourceRepository.upsertByExternalId({
      workspaceId: session.workspaceId,
      kind: "upload",
      name: "Course guide",
      externalId: `course-guide-${agentId}`,
    });

    const capabilities = await request(app).get(`/api/v1/agents/${agentId}/skill-capabilities`).set(headers);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "retrieve",
        available: true,
        requiresTarget: false,
        targets: [expect.objectContaining({ id: source.id, label: "Course guide" })],
      }),
    ]));

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "retrieve_course",
        capability: "retrieve",
        target: { kind: "source_scope", id: null },
        config: {
          sourceScope: { sourceIds: [source.id] },
          exposedInputs: { query: true },
        },
        invocationMode: "routine_named",
        enabled: true,
      });

    expect(created.status).toBe(201);
    expect(created.body.skill).toMatchObject({
      name: "retrieve_course",
      capability: "retrieve",
      storedKind: "retrieve",
      target: { kind: "source_scope", id: null },
      config: {
        sourceScope: { sourceIds: [source.id] },
        exposedInputs: { query: true },
      },
    });
  });

  it("lists a freshly created agent's default-answer retrieve skill without any explicit skill setup", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-default-retrieve-skill@example.com");
    const headers = adminSessionHeaders(session);

    const created = await request(app)
      .post("/api/v1/agents")
      .set(headers)
      .send({ name: "Fresh Agent" });
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;

    const listed = await request(app).get(`/api/v1/agents/${agentId}/skills`).set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toEqual([
      expect.objectContaining({
        name: "answer",
        capability: "retrieve",
        storedKind: "retrieve",
        target: { kind: "source_scope", id: null },
        invocationMode: "default_answer",
        enabled: true,
      }),
    ]);

    const disabled = await request(app)
      .post("/api/v1/agents")
      .set(headers)
      .send({ name: "Retrieval Off Agent", retrievalEnabled: false });
    expect(disabled.status).toBe(201);

    const disabledListed = await request(app).get(`/api/v1/agents/${disabled.body.id}/skills`).set(headers);
    expect(disabledListed.status).toBe(200);
    expect(disabledListed.body.skills).toEqual([
      expect.objectContaining({ name: "answer", enabled: false }),
    ]);
  });
});
