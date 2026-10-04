import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const PUBLIC_ID = /^ag_[A-Za-z0-9_-]{22}$/;

const setup = async () => {
  const { app, repositories } = createTestApp();
  const session = await issueTestSession(app);
  const created = await request(app)
    .post("/api/v1/agents")
    .set(adminSessionHeaders(session))
    .send({ name: "Returns desk" })
    .expect(201);
  return { app, repositories, session, agentId: created.body.id as string };
};

describe("agent public identity", () => {
  it("mints a public id the first time the card is published and keeps it across later writes", async () => {
    const { app, session, agentId } = await setup();

    const before = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(before.body.publicId).toBeNull();
    expect(before.body.agentCardEnabled).toBe(false);

    const published = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ agentCardEnabled: true, publicDescription: "Answers questions about returns." })
      .expect(200);
    expect(published.body.publicId).toMatch(PUBLIC_ID);
    expect(published.body.publicDescription).toBe("Answers questions about returns.");

    const later = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ publicDescription: "Answers questions about returns and refunds." })
      .expect(200);
    expect(later.body.publicId).toBe(published.body.publicId);
  });

  it("opens walk-in access with a per-hour budget and records the change", async () => {
    const { app, repositories, session, agentId } = await setup();

    const opened = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({
        agentCardEnabled: true,
        publicAgentAccessEnabled: true,
        walkInConversationsPerHour: 40,
      })
      .expect(200);

    expect(opened.body.publicAgentAccessEnabled).toBe(true);
    expect(opened.body.walkInConversationsPerHour).toBe(40);
    expect(opened.body.publicId).toMatch(PUBLIC_ID);

    const changed = repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "agent.public_access.changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      workspaceId: session.workspaceId,
      eventStatus: "success",
      metadata: expect.objectContaining({
        agentId,
        agentCardEnabled: true,
        publicAgentAccessEnabled: true,
      }),
    });
    expect(changed[0]?.accountId).toBe(session.accountId);
    expect(JSON.stringify(changed[0]?.metadata)).not.toContain(opened.body.publicId);
  });

  it("refuses walk-in access for an agent with no card to describe it", async () => {
    const { app, session, agentId } = await setup();

    const refused = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ publicAgentAccessEnabled: true })
      .expect(400);

    expect(refused.body.error.message).toMatch(/card/i);

    const unchanged = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(unchanged.body.publicId).toBeNull();
    expect(unchanged.body.publicAgentAccessEnabled).toBe(false);
  });

  it("rotates the public id and records who rotated it", async () => {
    const { app, repositories, session, agentId } = await setup();
    const published = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ agentCardEnabled: true, publicAgentAccessEnabled: true })
      .expect(200);

    const rotated = await request(app)
      .post(`/api/v1/agents/${agentId}/public-id/rotate`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(rotated.body.publicId).toMatch(PUBLIC_ID);
    expect(rotated.body.publicId).not.toBe(published.body.publicId);
    expect(rotated.body.publicAgentAccessEnabled).toBe(true);

    const events = repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "agent.public_id.rotated",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: session.workspaceId,
      eventStatus: "success",
      metadata: expect.objectContaining({ agentId }),
    });
    expect(events[0]?.accountId).toBe(session.accountId);
    // Rotation exists to revoke; recording either id would put the revoked key and its
    // replacement in the same searchable trail.
    expect(JSON.stringify(events[0]?.metadata)).not.toContain(rotated.body.publicId);
    expect(JSON.stringify(events[0]?.metadata)).not.toContain(published.body.publicId);
  });

  it("has nothing to rotate before the agent is discoverable", async () => {
    const { app, repositories, session, agentId } = await setup();

    await request(app)
      .post(`/api/v1/agents/${agentId}/public-id/rotate`)
      .set(adminSessionHeaders(session))
      .expect(400);

    expect(repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "agent.public_id.rotated",
    )).toHaveLength(0);
  });

  it("keeps a caller from choosing the public id, because minting is not a settings write", async () => {
    const { app, session, agentId } = await setup();
    const published = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ agentCardEnabled: true })
      .expect(200);

    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ publicId: "ag_attackerchosenvalue00" })
      .expect(200);

    const unchanged = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(unchanged.body.publicId).toBe(published.body.publicId);
  });
});
