import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import {
  directAnswerQueries,
  fallbackQueries,
  followUpQueries,
  noisyCorpusQueries,
  retrievalFixtureDocuments,
} from "../support/retrievalFixtures.js";

describe("retrieval benchmark integration", () => {
  it("covers direct, follow-up, noisy-corpus, and fallback scenarios with fixture data", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "benchmark@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    for (const document of Object.values(retrievalFixtureDocuments)) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 100,
        similarityThreshold: 0.2,
        rerankTopK: 20,
        warmthLevel: 5,
        citationDisplayEnabled: true,
      });

    for (const scenario of directAnswerQueries) {
      const response = await request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ query: scenario.query, stream: false });

      expect(response.status).toBe(200);
      expect(response.body.answer).not.toContain("could not find relevant information");
      expect(response.body.citations.some((citation: { title: string }) => scenario.expectedTitles.includes(citation.title))).toBe(
        true,
      );
    }

    const primer = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Tell me about the session cookie", stream: false });

    for (const scenario of followUpQueries) {
      const response = await request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ conversationId: primer.body.conversationId, query: scenario.query, stream: false });

      expect(response.status).toBe(200);
      expect(response.body.citations.some((citation: { title: string }) => scenario.expectedTitles.includes(citation.title))).toBe(
        true,
      );
    }

    for (const scenario of noisyCorpusQueries) {
      const response = await request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ query: scenario.query, stream: false });

      expect(response.status).toBe(200);
      expect(response.body.citations[0]?.title).toBe(scenario.expectedTitles[0]);
    }

    for (const scenario of fallbackQueries) {
      const response = await request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ query: scenario.query, stream: false });

      expect(response.status).toBe(200);
      expect(response.body.answer).toContain("could not find relevant information");
      expect(response.body.citations ?? []).toEqual([]);
    }
  });
});
