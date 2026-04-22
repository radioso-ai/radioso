import { describe, expect, it } from "vitest";

import { AuditEventAnalyticsSink } from "../../src/shared/analytics/auditEventAnalyticsSink.js";
import { AuditIncidentSink } from "../../src/shared/incidents/auditIncidentSink.js";
import { createAuditService, InMemoryAuditEventRepository } from "../support/fakes.js";

describe("audit-backed analytics and incident sinks", () => {
  it("persists product analytics events via the audit service", async () => {
    const repository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(repository);
    const sink = new AuditEventAnalyticsSink(auditService);

    await sink.emit({
      eventName: "chat.completed",
      timestamp: new Date().toISOString(),
      workspaceId: "workspace-1",
      subjectType: "conversation",
      subjectId: "conversation-1",
      properties: {
        stream: false,
      },
      source: "backend",
    });

    expect(repository.items).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "product.analytics",
        eventStatus: "success",
        metadata: {
          analytics: expect.objectContaining({
            eventName: "chat.completed",
          }),
        },
      }),
    );
  });

  it("persists incident events via the audit service", async () => {
    const repository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(repository);
    const sink = new AuditIncidentSink(auditService);

    await sink.record({
      incidentType: "http.request.unhandled",
      timestamp: new Date().toISOString(),
      severity: "error",
      service: "radioso-api",
      environment: "test",
      message: "boom",
      correlation: {
        workspaceId: "workspace-1",
        accountId: "account-1",
      },
    });

    expect(repository.items).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        workspaceId: "workspace-1",
        eventType: "incident.recorded",
        eventStatus: "failure",
        metadata: {
          incident: expect.objectContaining({
            incidentType: "http.request.unhandled",
          }),
        },
      }),
    );
  });
});
