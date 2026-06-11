import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("settings webhook destinations contract", () => {
  it("creates, reads, updates, rotates, and deletes webhook destinations without exposing read secrets", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "webhook-destinations@example.com");
    const headers = adminSessionHeaders(session);

    const created = await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "crm-leads", url: "https://hooks.example.com/leads" });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      destination: {
        id: expect.any(String),
        name: "crm-leads",
        url: "https://hooks.example.com/leads",
      },
      secret: expect.any(String),
    });
    const destinationId = created.body.destination.id as string;
    const firstSecret = created.body.secret as string;

    const list = await request(app)
      .get("/api/v1/settings/webhook-destinations")
      .set(headers);

    expect(list.status).toBe(200);
    expect(list.body.destinations).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(firstSecret);
    expect(list.body.destinations[0]).not.toHaveProperty("secret");

    const get = await request(app)
      .get(`/api/v1/settings/webhook-destinations/${destinationId}`)
      .set(headers);
    expect(get.status).toBe(200);
    expect(get.body.destination).toMatchObject({ id: destinationId, name: "crm-leads" });
    expect(JSON.stringify(get.body)).not.toContain(firstSecret);

    const updated = await request(app)
      .put(`/api/v1/settings/webhook-destinations/${destinationId}`)
      .set(headers)
      .send({ name: "crm-leads-v2", url: "https://hooks.example.com/leads-v2" });
    expect(updated.status).toBe(200);
    expect(updated.body.destination).toMatchObject({
      id: destinationId,
      name: "crm-leads-v2",
      url: "https://hooks.example.com/leads-v2",
    });

    const rotated = await request(app)
      .post(`/api/v1/settings/webhook-destinations/${destinationId}/rotate-secret`)
      .set(headers);
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toEqual(expect.any(String));
    expect(rotated.body.secret).not.toBe(firstSecret);

    const deleted = await request(app)
      .delete(`/api/v1/settings/webhook-destinations/${destinationId}`)
      .set(headers);
    expect(deleted.status).toBe(204);
  });

  it("rejects duplicate names and non-https URLs", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "webhook-destinations-invalid@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "CRM", url: "https://hooks.example.com/a" })
      .expect(201);

    const duplicate = await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "crm", url: "https://hooks.example.com/b" });
    expect(duplicate.status).toBe(409);

    const http = await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "plain-http", url: "http://example.com/hook" });
    expect(http.status).toBe(400);
  });

  it("normalizes uppercase https schemes and rejects malformed destination ids", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "webhook-destinations-ids@example.com");
    const headers = adminSessionHeaders(session);

    const created = await request(app)
      .post("/api/v1/settings/webhook-destinations")
      .set(headers)
      .send({ name: "crm-leads", url: "HTTPS://hooks.example.com/leads" });

    expect(created.status).toBe(201);
    expect(created.body.destination.url).toBe("https://hooks.example.com/leads");

    const invalidGet = await request(app)
      .get("/api/v1/settings/webhook-destinations/not-a-uuid")
      .set(headers);

    expect(invalidGet.status).toBe(400);
  });

  it("requires authentication", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .get("/api/v1/settings/webhook-destinations");

    expect(response.status).toBe(401);
  });
});
