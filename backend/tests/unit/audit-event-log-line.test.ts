import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { AuditService } from "../../src/modules/audit/services/auditService.js";
import {
  runWithRequestAuditContext,
  setRequestAuditPrincipal,
} from "../../src/shared/observability/requestAuditContext.js";
import { InMemoryAuditEventRepository } from "../support/fakes.js";

const captureAuditLog = (): { service: AuditService; lines: () => Record<string, unknown>[]; raw: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    service: new AuditService(pino({ level: "info" }, stream), new InMemoryAuditEventRepository()),
    lines: () => chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
    raw: () => chunks.join(""),
  };
};

const visitorQuestion = "where can I pray five times a day during the retreat";
const rewrittenQuery = "prayer times during retreat";
const lexicalQuery = "prayer retreat schedule";

describe("audit_event log line", () => {
  it("logs none of a visitor's query text, raw or parsed", async () => {
    const { service, raw } = captureAuditLog();

    await service.record({
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: randomUUID(),
        query: visitorQuestion,
        retrieval: {
          rewriteStatus: "applied",
          rerankStatus: "applied",
          originalCandidateCount: 12,
          rewrittenCandidateCount: 9,
          lexicalCandidateCount: 5,
          normalizedCandidateCount: 14,
          finalContextCount: 4,
          parsedQuery: { originalQuery: visitorQuestion, semanticQuery: rewrittenQuery, lexicalQuery },
          appliedConstraints: [],
          candidateFallbackApplied: false,
          fallbackApplied: false,
        },
      },
    });

    expect(raw()).not.toContain(visitorQuestion);
    expect(raw()).not.toContain(rewrittenQuery);
    expect(raw()).not.toContain(lexicalQuery);
  });

  it("drops free-text metadata wherever it sits", async () => {
    const { service, lines, raw } = captureAuditLog();

    await service.record({
      workspaceId: randomUUID(),
      eventType: "document.search",
      eventStatus: "failure",
      metadata: {
        query: visitorQuestion,
        errorMessage: `Search failed for "${visitorQuestion}"`,
        snapshot: { results: [{ title: "Friday prayers", excerpt: visitorQuestion }] },
        suggestions: [visitorQuestion],
        role: visitorQuestion,
        requestId: visitorQuestion,
        stage: visitorQuestion,
        surface: visitorQuestion,
        analytics: {
          eventName: "chat.failed",
          timestamp: new Date().toISOString(),
          subjectType: "conversation",
          subjectId: visitorQuestion,
          source: "frontend",
        },
        error: {
          errorType: "http.request.unhandled",
          severity: "error",
          errorClass: `Failed on ${visitorQuestion}`,
          message: visitorQuestion,
          correlation: { route: `/api/v1/history?q=${encodeURIComponent(visitorQuestion)}` },
          requestContext: { method: "GET", route: `/api/v1/history?q=${encodeURIComponent(visitorQuestion)}#top` },
        },
      },
    });

    expect(raw()).not.toContain(visitorQuestion);
    expect(raw()).not.toContain(encodeURIComponent(visitorQuestion));
    expect(raw()).not.toContain("Friday prayers");
    expect(lines()[0]?.error).toMatchObject({ method: "GET", route: "/api/v1/history" });
  });

  it("still logs an event whose error metadata holds a malformed route or class", async () => {
    const { service, lines } = captureAuditLog();

    await service.record({
      workspaceId: randomUUID(),
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: {
        error: {
          errorType: "http.request.unhandled",
          severity: "error",
          errorClass: 42,
          correlation: { route: 7 },
          requestContext: { method: "GET", route: ["/api/v1/history"] },
        },
      },
    });

    expect(lines()[0]?.error).toEqual({ errorType: "http.request.unhandled", severity: "error", method: "GET" });
  });

  it("keeps the ids, counts, flags and statuses a log query correlates on", async () => {
    const { service, lines } = captureAuditLog();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const credentialId = randomUUID();
    const principalId = randomUUID();

    await runWithRequestAuditContext({ requestId: "42" }, async () => {
      setRequestAuditPrincipal({ credentialId, principalId, principalKind: "service", role: "admin" });
      await service.record({
        accountId,
        workspaceId,
        eventType: "chat.answer",
        eventStatus: "success",
        metadata: {
          conversationId,
          citationCount: 2,
          latencyMs: 812,
          streamed: true,
          stage: "chat.answer",
          workflow: "chat.turn",
          executionClass: "interactive_synchronous",
          executionMode: "safe_test",
          surface: "web",
          analytics: {
            eventName: "chat.failed",
            timestamp: new Date().toISOString(),
            subjectType: "conversation",
            subjectId: conversationId,
            source: "backend",
          },
          retrieval: {
            rewriteStatus: "applied",
            rerankStatus: "fallback",
            originalCandidateCount: 12,
            rewrittenCandidateCount: 9,
            lexicalCandidateCount: 5,
            normalizedCandidateCount: 14,
            finalContextCount: 4,
            parsedQuery: { semanticQuery: rewrittenQuery, lexicalQuery },
            appliedConstraints: [{ signalKey: "language", mode: "boost_only", outcome: "applied", summary: "Preferred English" }],
            candidateFallbackApplied: false,
            fallbackApplied: true,
          },
          error: {
            errorType: "retrieval.rerank_failed",
            severity: "warning",
            errorClass: "TypeError",
            correlation: { workspaceId, conversationId },
          },
        },
      });
    });

    const [line] = lines();
    expect(line?.msg).toBe("audit_event");
    expect(line?.audit).toEqual({
      accountId,
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId,
        citationCount: 2,
        latencyMs: 812,
        streamed: true,
        stage: "chat.answer",
        workflow: "chat.turn",
        executionClass: "interactive_synchronous",
        executionMode: "safe_test",
        surface: "web",
        requestId: "42",
        credentialId,
        principalId,
        principalKind: "service",
        role: "admin",
      },
    });
    expect(line?.retrieval).toEqual({
      rewriteStatus: "applied",
      rerankStatus: "fallback",
      originalCandidateCount: 12,
      rewrittenCandidateCount: 9,
      lexicalCandidateCount: 5,
      normalizedCandidateCount: 14,
      finalContextCount: 4,
      appliedConstraintCount: 1,
      candidateFallbackApplied: false,
      fallbackApplied: true,
    });
    expect(line?.analytics).toMatchObject({ subjectType: "conversation", subjectId: conversationId, source: "backend" });
    expect(line?.error).toEqual({
      errorType: "retrieval.rerank_failed",
      severity: "warning",
      errorClass: "TypeError",
      workspaceId,
      conversationId,
    });
  });
});
