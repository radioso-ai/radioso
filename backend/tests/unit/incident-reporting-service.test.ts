import { describe, expect, it, vi } from "vitest";

import { IncidentReportingService } from "../../src/shared/incidents/incidentReportingService.js";
import type { IncidentSink } from "../../src/shared/incidents/incidentSink.js";

const createLogger = () => ({
  error: vi.fn(),
  info: vi.fn(),
});

describe("IncidentReportingService", () => {
  it("normalizes unhandled request errors and records them", async () => {
    const sink: IncidentSink = {
      record: vi.fn().mockResolvedValue(undefined),
    };
    const logger = createLogger();
    const service = new IncidentReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [sink],
      version: "test",
    });

    const incident = await service.reportUnhandledRequestError({
      error: new Error("boom"),
      request: {
        id: "req-1",
        method: "GET",
        originalUrl: "/api/v1/settings/retrieval",
        header(name) {
          return name === "x-workspace-id" ? "workspace-1" : undefined;
        },
      },
      statusCode: 500,
    });

    expect(incident).toMatchObject({
      incidentType: "http.request.unhandled",
      message: "boom",
      errorClass: "Error",
      correlation: {
        requestId: "req-1",
        workspaceId: "workspace-1",
      },
      requestContext: {
        method: "GET",
        route: "/api/v1/settings/retrieval",
        statusCode: 500,
      },
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      incidentType: "http.request.unhandled",
    }));
  });

  it("redacts sensitive metadata and logs sink failures", async () => {
    const logger = createLogger();
    const service = new IncidentReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [
        {
          record: vi.fn().mockRejectedValue(new Error("sink down")),
        },
      ],
    });

    const incident = await service.report({
      incidentType: "test.incident",
      error: {
        prompt: "private",
      },
    });

    expect(incident?.metadata).toEqual({
      prompt: "[REDACTED]",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "sink down", incidentType: "test.incident" }),
      "incident_sink_failed",
    );
  });
});
