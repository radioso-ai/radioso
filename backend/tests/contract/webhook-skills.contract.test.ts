import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("webhook skills contract", () => {
  it("creates, lists, updates, deletes, and validates agent webhook skill definitions", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "webhook-skills@example.com");
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

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/webhook-skills`)
      .set(headers)
      .send({
        skillName: "send_lead_webhook",
        destinationId,
        boundPayload: { source: "routine" },
        exposedPayload: {
          email: { slotBinding: "customerEmail" },
          message: { slotBinding: "messageBody" },
        },
        enabled: true,
      });

    expect(created.status).toBe(201);
    expect(created.body.skill).toMatchObject({
      id: expect.any(String),
      skillName: "send_lead_webhook",
      destinationId,
      enabled: true,
      outcomes: ["delivered", "missing_input", "destination_not_found", "failed"],
    });

    const listed = await request(app).get(`/api/v1/agents/${agentId}/webhook-skills`).set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toEqual([
      expect.objectContaining({ id: created.body.skill.id, skillName: "send_lead_webhook" }),
    ]);

    const duplicate = await request(app)
      .post(`/api/v1/agents/${agentId}/webhook-skills`)
      .set(headers)
      .send({
        skillName: "send_lead_webhook",
        destinationId,
        boundPayload: {},
        exposedPayload: {},
      });
    expect(duplicate.status).toBe(409);

    const updated = await request(app)
      .patch(`/api/v1/agents/${agentId}/webhook-skills/${created.body.skill.id}`)
      .set(headers)
      .send({
        enabled: false,
        boundPayload: { source: "routine-v2" },
        exposedPayload: {
          email: { slotBinding: "customerEmail", required: true },
        },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.skill).toMatchObject({ enabled: false, boundPayload: { source: "routine-v2" } });

    const invalid = await request(app)
      .post(`/api/v1/agents/${agentId}/webhook-skills`)
      .set(headers)
      .send({
        skillName: "bad.name",
        destinationId,
        boundPayload: {},
        exposedPayload: {},
      });
    expect(invalid.status).toBe(400);

    const blockedDestinationDelete = await request(app)
      .delete(`/api/v1/settings/webhook-destinations/${destinationId}`)
      .set(headers);
    expect(blockedDestinationDelete.status).toBe(409);

    const removed = await request(app)
      .delete(`/api/v1/agents/${agentId}/webhook-skills/${created.body.skill.id}`)
      .set(headers);
    expect(removed.status).toBe(204);
  });
});
