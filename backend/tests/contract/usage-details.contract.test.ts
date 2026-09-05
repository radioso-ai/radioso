import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createUsageDetailsRoutes } from "../../src/modules/reporting/usageDetailsRoutes.js";
import type { UsageDetailsServicePort } from "../../src/modules/reporting/contracts/index.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

type DetailServiceMethods = {
  getMessageUsage: ReturnType<typeof vi.fn>;
  getInternalUsage: ReturnType<typeof vi.fn>;
};

const responseFilters = { workspaceId: null };

const reportingService = (): UsageDetailsServicePort & DetailServiceMethods => ({
  getMessageUsage: vi.fn().mockResolvedValue({
    from: "2026-07-01",
    to: "2026-07-30",
    filters: responseFilters,
    items: [{
      messageId: "7bb5fab1-9a51-4d61-9c14-e33f9b4d5ac3",
      conversationId: "3a95dc62-0874-4d1e-ae13-591c37025d35",
      workspaceId: "f8325957-1192-44d9-b7a8-64c20ac399e6",
      agentId: "5ac7d23b-35a8-4965-9a9c-2cc1bbcef0e7",
      lastOccurredAt: "2026-07-30T12:01:00.000Z",
      providers: ["openai"],
      models: ["gpt-5"],
      operations: [{ surface: "assistant", name: "answer", label: "Answer" }],
      attempts: { total: 2, succeeded: 2, failed: 0 },
      quality: { actual: 2, estimated: 0 },
      modelTokens: {
        input: 120,
        completion: 40,
        reasoning: { tokens: 12, coverage: "complete" },
        visibleOutput: 28,
        total: 160,
      },
      embeddingTokens: { input: 9, total: 9, vectors: 1, attempts: 1 },
      unknownHistorical: { total: 0, attempts: 0 },
    }],
    nextCursor: null,
  }),
  getInternalUsage: vi.fn().mockResolvedValue({
    from: "2026-07-01",
    to: "2026-07-30",
    filters: responseFilters,
    items: [{
      eventId: "2d02cec5-8e4e-4bb8-b0d1-e722f57932d9",
      workspaceId: "f8325957-1192-44d9-b7a8-64c20ac399e6",
      agentId: "5ac7d23b-35a8-4965-9a9c-2cc1bbcef0e7",
      occurredAt: "2026-07-30T12:02:00.000Z",
      kind: "embedding",
      operation: { surface: "documents", name: "document_enrichment", label: "Metadata generation" },
      provider: "openai",
      model: "text-embedding-3-small",
      status: "succeeded",
      usageQuality: "actual",
      tokens: { input: 100, completion: null, reasoning: null, visibleOutput: null, total: 100 },
      vectorCount: 1,
    }],
    nextCursor: null,
  }),
});

describe("usage details contract", () => {
  it("returns safe, typed message and internal detail responses for an active member", async () => {
    const service = reportingService();
    const { app } = createTestApp({
      applicationRouteMounts: [{
        path: "/api/v1/account",
        createRouter: (dependencies) => createUsageDetailsRoutes(dependencies, service),
      }],
    });
    const session = await issueTestSession(app, "usage-details-member@example.com");
    const query = { from: "2026-07-01", to: "2026-07-30", limit: "50" };

    const messages = await request(app)
      .get("/api/v1/account/usage/messages")
      .query(query)
      .set(adminSessionHeaders(session));
    const internal = await request(app)
      .get("/api/v1/account/usage/internal-operations")
      .query(query)
      .set(adminSessionHeaders(session));

    expect(messages.status).toBe(200);
    expect(messages.body.items[0]).toMatchObject({
      conversationId: "3a95dc62-0874-4d1e-ae13-591c37025d35",
      modelTokens: { reasoning: { coverage: "complete" }, visibleOutput: 28 },
      embeddingTokens: { vectors: 1 },
    });
    expect(JSON.stringify(messages.body)).not.toMatch(/idempotency|providerRequest|errorCode|prompt|content/i);
    expect(internal.status).toBe(200);
    expect(internal.body.items[0]).toMatchObject({
      kind: "embedding",
      operation: { label: "Metadata generation" },
      vectorCount: 1,
    });
    expect(service.getMessageUsage).toHaveBeenCalledWith({
      accountId: session.accountId,
      userId: session.userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
      workspaceId: undefined,
      cursor: undefined,
    });
    expect(service.getInternalUsage).toHaveBeenCalledWith({
      accountId: session.accountId,
      userId: session.userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
      workspaceId: undefined,
      cursor: undefined,
    });
  });

  it("requires a session and rejects malformed detailed-usage filters", async () => {
    const service = reportingService();
    const { app } = createTestApp({
      applicationRouteMounts: [{
        path: "/api/v1/account",
        createRouter: (dependencies) => createUsageDetailsRoutes(dependencies, service),
      }],
    });

    const unauthenticated = await request(app)
      .get("/api/v1/account/usage/messages")
      .query({ from: "2026-07-01", to: "2026-07-30" });
    expect(unauthenticated.status).toBe(401);

    const session = await issueTestSession(app, "usage-details-invalid@example.com");
    const invalid = await request(app)
      .get("/api/v1/account/usage/internal-operations")
      .query({ from: "not-a-date", to: "2026-07-30", limit: "101" })
      .set(adminSessionHeaders(session));
    expect(invalid.status).toBe(400);
    expect(service.getInternalUsage).not.toHaveBeenCalled();
  });
});
