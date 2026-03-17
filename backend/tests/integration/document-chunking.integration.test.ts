import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("document chunking integration", () => {
  it("applies the structured strategy to newly ingested documents", async () => {
    const { app, repositories } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "structured-ingest@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const document = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Playbook",
        content: `# Intro

Welcome to Hivec.

- Open Settings
- Choose a strategy

## FAQ

What changes now?

Only future ingests change.`,
      });

    expect(document.status).toBe(202);
    const storedChunks = repositories.chunkRepository.items.get(document.body.documentId) ?? [];
    expect(storedChunks.length).toBeGreaterThan(1);
    expect(storedChunks.some((chunk) => chunk.content.includes("Open Settings"))).toBe(true);
    expect(storedChunks.some((chunk) => chunk.content.includes("What changes now?"))).toBe(true);
  });

  it("does not rewrite existing chunks until the document is updated", async () => {
    const { app, repositories } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "strategy-update@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    const created = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Original",
        content: "word ".repeat(400),
      });

    const originalChunks = [...(repositories.chunkRepository.items.get(created.body.documentId) ?? [])];

    const settings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    expect(settings.status).toBe(200);
    expect(repositories.chunkRepository.items.get(created.body.documentId)).toEqual(originalChunks);

    const updated = await request(app)
      .put(`/api/v1/document/${created.body.documentId}`)
      .set("Authorization", authorization)
      .send({
        title: "Updated",
        content: `# Updated

Alpha details.

## Follow-up

What changed?

Chunking behavior.`,
      });

    expect(updated.status).toBe(202);
    const updatedChunks = repositories.chunkRepository.items.get(created.body.documentId) ?? [];
    expect(updatedChunks).not.toEqual(originalChunks);
    expect(updatedChunks.some((chunk) => chunk.content.includes("What changed?"))).toBe(true);
  });
});
