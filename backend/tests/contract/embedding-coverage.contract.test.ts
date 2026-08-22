import { describe, it, expect } from "vitest";
import request from "supertest";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

// Canonical embedding coverage is otherwise only visible by querying the database
// directly, which is what made the backfill in issue #1063 unobservable to whoever was
// running it. This endpoint is where the dashboard reads it.

describe("embedding coverage contract", () => {
  it("reports complete coverage for a workspace with nothing indexed yet", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .get("/api/v1/settings/ingestion/embedding-coverage")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eligibleChunks: 0,
      coveredChunks: 0,
      missingChunks: 0,
      hasEmbeddingProfile: false,
      queuedJobs: 0,
      failedJobs: 0,
    });
  });

  it("returns the counts an operator needs to tell progress from a stall", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app);
    repositories.documentProcessingJobRepository.canonicalEmbeddingCoverage.set(
      session.workspaceId,
      {
        eligibleChunks: 19_318,
        coveredChunks: 14_989,
        missingChunks: 4_329,
        hasEmbeddingProfile: true,
        queuedJobs: 12,
        failedJobs: 3,
      },
    );

    const response = await request(app)
      .get("/api/v1/settings/ingestion/embedding-coverage")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eligibleChunks: 19_318,
      coveredChunks: 14_989,
      missingChunks: 4_329,
      hasEmbeddingProfile: true,
      queuedJobs: 12,
      // A failed job holds its key, so its chunks can never be re-enqueued. Without
      // this count a stuck workspace looks the same as one still working through a queue.
      failedJobs: 3,
    });
  });

  it("requires a session", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .get("/api/v1/settings/ingestion/embedding-coverage");

    expect(response.status).toBe(401);
  });
});
