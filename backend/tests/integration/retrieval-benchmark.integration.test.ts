import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import {
  constraintQueries,
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
        chunkingStrategy: "fixed_window",
        attributeControls: [
          { family: "date_point", enabled: true, mode: "hard_filter" },
          { family: "date_range", enabled: true, mode: "boost_only" },
          { family: "money_value", enabled: true, mode: "hard_filter" },
          { family: "location", enabled: true, mode: "hard_filter" },
        ],
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

    for (const scenario of constraintQueries) {
      const response = await request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ query: scenario.query, stream: false });

      expect(response.status).toBe(200);
      expect(response.body.answer).not.toContain("could not find relevant information");
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

  it("keeps hybrid retrieval at least as effective as a lexical-disabled baseline within bounded runtime", async () => {
    const hybrid = createTestApp();
    const vectorOnly = createTestApp({
      lexicalSearch: {
        async search() {
          return [];
        },
      },
    });

    const setupAccount = async (app: ReturnType<typeof createTestApp>["app"], email: string) => {
      const register = await request(app).post("/api/v1/auth/register").send({
        email,
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
          chunkingStrategy: "fixed_window",
          attributeControls: [
            { family: "date_point", enabled: true, mode: "hard_filter" },
            { family: "date_range", enabled: true, mode: "boost_only" },
            { family: "money_value", enabled: true, mode: "hard_filter" },
            { family: "location", enabled: true, mode: "hard_filter" },
          ],
        });

      return authorization;
    };

    const hybridAuthorization = await setupAccount(hybrid.app, "benchmark-hybrid@example.com");
    const vectorOnlyAuthorization = await setupAccount(vectorOnly.app, "benchmark-vector@example.com");
    const benchmarkQueries = [...directAnswerQueries, ...noisyCorpusQueries, ...constraintQueries];

    const measureSuccesses = async (
      app: ReturnType<typeof createTestApp>["app"],
      authorization: string,
    ): Promise<{ successCount: number; durationMs: number }> => {
      const startedAt = Date.now();
      let successCount = 0;

      for (const scenario of benchmarkQueries) {
        const response = await request(app)
          .post("/api/v1/chat/")
          .set("Authorization", authorization)
          .send({ query: scenario.query, stream: false });

        if (
          response.status === 200 &&
          response.body.citations?.some((citation: { title: string }) => scenario.expectedTitles.includes(citation.title))
        ) {
          successCount += 1;
        }
      }

      return {
        successCount,
        durationMs: Date.now() - startedAt,
      };
    };

    const hybridResult = await measureSuccesses(hybrid.app, hybridAuthorization);
    const vectorOnlyResult = await measureSuccesses(vectorOnly.app, vectorOnlyAuthorization);

    expect(hybridResult.successCount).toBeGreaterThanOrEqual(vectorOnlyResult.successCount);
    expect(hybridResult.durationMs).toBeLessThan(5000);
    expect(vectorOnlyResult.durationMs).toBeLessThan(5000);
  });
});
