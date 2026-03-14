import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

const issueToken = async (app: ReturnType<typeof createTestApp>["app"]) => {
  const register = await request(app).post("/api/v1/auth/register").send({
    email: "settings@example.com",
    password: "verysecurepassword",
  });

  const token = await request(app)
    .get("/api/v1/account/token")
    .set("Cookie", register.headers["set-cookie"][0]);

  return token.body.token as string;
};

describe("retrieval settings contract", () => {
  it("returns default retrieval settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .get("/api/v1/settings/retrieval")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      "accountId",
      "attributeControls",
      "chunkingStrategy",
      "citationDisplayEnabled",
      "createdAt",
      "queryRewriteEnabled",
      "rerankEnabled",
      "rerankTopK",
      "similarityThreshold",
      "updatedAt",
      "vectorTopK",
      "warmthLevel",
    ]);
    expect(response.body.vectorTopK).toBe(15);
    expect(response.body.warmthLevel).toBe(5);
    expect(response.body.citationDisplayEnabled).toBe(true);
    expect(response.body.chunkingStrategy).toBe("fixed_window");
    expect(response.body.attributeControls).toEqual([
      { family: "date_point", enabled: true, mode: "boost_only" },
      { family: "date_range", enabled: true, mode: "boost_only" },
      { family: "money_value", enabled: true, mode: "boost_only" },
      { family: "location", enabled: true, mode: "boost_only" },
    ]);
  });

  it("updates retrieval settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", `Bearer ${token}`)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
      rerankTopK: 6,
      warmthLevel: 8,
      citationDisplayEnabled: false,
      chunkingStrategy: "structured_semantic",
      attributeControls: [
        { family: "date_point", enabled: true, mode: "hard_filter" },
        { family: "date_range", enabled: true, mode: "boost_only" },
        { family: "money_value", enabled: false, mode: "boost_only" },
        { family: "location", enabled: true, mode: "boost_only" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      queryRewriteEnabled: true,
      rerankEnabled: true,
      vectorTopK: 12,
      similarityThreshold: 0.4,
      rerankTopK: 6,
      warmthLevel: 8,
      citationDisplayEnabled: false,
      chunkingStrategy: "structured_semantic",
      attributeControls: [
        { family: "date_point", enabled: true, mode: "hard_filter" },
        { family: "date_range", enabled: true, mode: "boost_only" },
        { family: "money_value", enabled: false, mode: "boost_only" },
        { family: "location", enabled: true, mode: "boost_only" },
      ],
    });
    expect(Object.keys(response.body).sort()).toEqual([
      "accountId",
      "attributeControls",
      "chunkingStrategy",
      "citationDisplayEnabled",
      "createdAt",
      "queryRewriteEnabled",
      "rerankEnabled",
      "rerankTopK",
      "similarityThreshold",
      "updatedAt",
      "vectorTopK",
      "warmthLevel",
    ]);
  });

  it("preserves saved attribute controls when an older client omits the field", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);
    const authorization = `Bearer ${token}`;

    const firstUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
        rerankTopK: 6,
        warmthLevel: 8,
        citationDisplayEnabled: false,
        chunkingStrategy: "structured_semantic",
        attributeControls: [
          { family: "date_point", enabled: true, mode: "hard_filter" },
          { family: "date_range", enabled: false, mode: "boost_only" },
          { family: "money_value", enabled: false, mode: "boost_only" },
          { family: "location", enabled: true, mode: "boost_only" },
        ],
      });

    const secondUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    expect(firstUpdate.status).toBe(200);
    expect(secondUpdate.status).toBe(200);
    expect(secondUpdate.body.attributeControls).toEqual(firstUpdate.body.attributeControls);
  });

  it("documents attributeControls as optional for the update request schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");
    const retrievalSettingsSchema = spec.match(/RetrievalSettings:\n([\s\S]*?)\n    UpdateRetrievalSettingsRequest:/)?.[1] ?? "";
    const updateSchema = spec.match(/UpdateRetrievalSettingsRequest:\n([\s\S]*?)\n    AttributeFamilyControl:/)?.[1] ?? "";

    expect(retrievalSettingsSchema).toContain("- accountId");
    expect(retrievalSettingsSchema).toContain("- createdAt");
    expect(retrievalSettingsSchema).toContain("- updatedAt");
    expect(retrievalSettingsSchema).toContain("accountId:");
    expect(retrievalSettingsSchema).toContain("format: uuid");
    expect(retrievalSettingsSchema).toContain("createdAt:");
    expect(retrievalSettingsSchema).toContain("format: date-time");
    expect(retrievalSettingsSchema).toContain("updatedAt:");
    expect(updateSchema).toContain("type: object");
    expect(updateSchema).toContain("- chunkingStrategy");
    expect(updateSchema).toContain("attributeControls:");
    expect(updateSchema).not.toContain("- attributeControls");
    expect(updateSchema).not.toContain("allOf:");
  });
});
