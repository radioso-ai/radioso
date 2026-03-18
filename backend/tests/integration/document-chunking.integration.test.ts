import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("document chunking integration", () => {
  it("applies the structured strategy to newly ingested documents", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "structured-ingest@example.com");
    const authorization = `Bearer ${token}`;

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

  it("propagates document metadata to every chunk produced during processing", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "metadata-propagation@example.com");
    const authorization = `Bearer ${token}`;

    const document = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Source Guide",
        content: "This guide explains how to use the API for external integrations.",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    expect(document.status).toBe(202);
    const storedChunks = repositories.chunkRepository.items.get(document.body.documentId) ?? [];
    expect(storedChunks.length).toBeGreaterThan(0);
    for (const chunk of storedChunks) {
      expect(chunk.metadata).toMatchObject({ sourceUrl: "https://example.com", language: "en" });
    }
  });

  it("does not rewrite existing chunks until the document is updated", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "strategy-update@example.com");
    const authorization = `Bearer ${token}`;

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
