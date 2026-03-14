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
    });
    expect(Object.keys(response.body).sort()).toEqual([
      "accountId",
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
});
