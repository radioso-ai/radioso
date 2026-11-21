import request from "supertest";
import { describe, expect, it } from "vitest";

import { NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const createWebsiteSource = async (
  app: ReturnType<typeof createTestApp>["app"],
  session: Awaited<ReturnType<typeof issueTestSession>>,
  url = "https://docs.example",
) => {
  for (const page of ["one", "two"]) {
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: page, content: `Page ${page}.`, externalDocumentId: `website:${url}:${url}/${page}`, source: { kind: "website", url } })
      .expect(202);
  }
  const listed = await request(app).get("/api/v1/document/sources").set(adminSessionHeaders(session)).expect(200);
  return listed.body.sources.find((source: { kind: string }) => source.kind === "website") as { id: string; recrawlCadence: string };
};

describe("website recrawl contract", () => {
  it("lists a website source's recrawl cadence, next recrawl, held pages and the plan's fastest cadence", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "recrawl-list@example.com");

    const source = await createWebsiteSource(app, session);

    expect(source).toMatchObject({
      recrawlCadence: "off",
      nextRecrawlAt: null,
      heldPageCount: 0,
      fastestRecrawlCadence: "daily",
    });
  });

  it("sets and clears a website source's recrawl cadence", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "recrawl-set@example.com");
    const source = await createWebsiteSource(app, session);

    const set = await request(app)
      .put(`/api/v1/document/sources/${source.id}/recrawl-cadence`)
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "daily" })
      .expect(200);
    expect(set.body).toMatchObject({ id: source.id, recrawlCadence: "daily", nextRecrawlAt: expect.any(String), fastestRecrawlCadence: "daily" });

    const cleared = await request(app)
      .put(`/api/v1/document/sources/${source.id}/recrawl-cadence`)
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "off" })
      .expect(200);
    expect(cleared.body).toMatchObject({ recrawlCadence: "off", nextRecrawlAt: null });

    await request(app)
      .put(`/api/v1/document/sources/${source.id}/recrawl-cadence`)
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "hourly" })
      .expect(400);
  });

  it("refuses a cadence faster than the plan allows with a typed error", async () => {
    const { app } = createTestApp({
      usageLimitPolicy: Object.assign(new NoopUsageLimitPolicy(), { getFastestRecrawlCadence: async () => "weekly" as const }),
    });
    const session = await issueTestSession(app, "recrawl-plan@example.com");
    const source = await createWebsiteSource(app, session);
    expect(source).toMatchObject({ fastestRecrawlCadence: "weekly" });

    const refused = await request(app)
      .put(`/api/v1/document/sources/${source.id}/recrawl-cadence`)
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "daily" })
      .expect(403);
    expect(refused.body.error).toMatchObject({ code: "recrawl_cadence_not_in_plan", details: { fastestRecrawlCadence: "weekly" } });

    await request(app)
      .put(`/api/v1/document/sources/${source.id}/recrawl-cadence`)
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "weekly" })
      .expect(200);
  });

  it("refuses a cadence on a source that is not a website", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "recrawl-upload@example.com");

    await request(app)
      .put("/api/v1/document/sources/00000000-0000-0000-0000-000000000001/recrawl-cadence")
      .set(adminSessionHeaders(session))
      .send({ recrawlCadence: "weekly" })
      .expect(404);
  });

  it("removes or keeps the pages a scheduled crawl held", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "recrawl-held@example.com");
    const source = await createWebsiteSource(app, session);
    const documents = [...repositories.documentRepository.items.values()].filter((document) => document.sourceId === source.id);
    const [first, second] = documents;
    repositories.websiteMissingPageStore.hold({ workspaceId: first.workspaceId, sourceId: source.id, documentIds: [first.id] });

    const listed = await request(app).get("/api/v1/document/sources").set(adminSessionHeaders(session)).expect(200);
    expect(listed.body.sources.find((entry: { id: string }) => entry.id === source.id)).toMatchObject({ heldPageCount: 1 });

    const removed = await request(app)
      .post(`/api/v1/document/sources/${source.id}/held-pages/remove`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(removed.body).toEqual({ sourceId: source.id, removedPageCount: 1 });
    expect(repositories.documentRepository.items.has(first.id)).toBe(false);

    repositories.websiteMissingPageStore.hold({ workspaceId: second.workspaceId, sourceId: source.id, documentIds: [second.id] });
    const kept = await request(app)
      .post(`/api/v1/document/sources/${source.id}/held-pages/keep`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(kept.body).toEqual({ sourceId: source.id, keptPageCount: 1 });
    expect(repositories.documentRepository.items.has(second.id)).toBe(true);

    const after = await request(app).get("/api/v1/document/sources").set(adminSessionHeaders(session)).expect(200);
    expect(after.body.sources.find((entry: { id: string }) => entry.id === source.id)).toMatchObject({ heldPageCount: 0 });
  });
});
