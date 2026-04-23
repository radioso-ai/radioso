import { describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";

describe("audit logger", () => {
  it("sanitizes secrets before sending events to sinks", async () => {
    const sink = { write: vi.fn().mockResolvedValue(undefined) };
    const logger = createAuditLogger([sink]);

    await logger.emit({
      eventType: "auth.exchange_succeeded",
      metadata: {
        accessToken: "mcp_sess_secret",
        approvalToken: "mcp_appr_secret",
        clientName: "cursor-local",
        nested: {
          upstreamApiToken: "sk_proj_secret",
        },
      },
      outcome: "success",
      sessionId: "sess_01",
      toolName: "search_documents",
    });

    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.write.mock.calls[0][0]).toMatchObject({
      eventType: "auth.exchange_succeeded",
      metadata: {
        clientName: "cursor-local",
        accessToken: "[redacted]",
        approvalToken: "[redacted]",
        nested: {
          upstreamApiToken: "[redacted]",
        },
      },
    });
  });

  it("continues after sink failures so audit issues do not break the caller", async () => {
    const failingSink = { write: vi.fn().mockRejectedValue(new Error("disk full")) };
    const passingSink = { write: vi.fn().mockResolvedValue(undefined) };
    const logger = createAuditLogger([failingSink, passingSink]);

    await expect(
      logger.emit({
        eventType: "tool.executed",
        outcome: "success",
        toolName: "describe_capabilities",
      }),
    ).resolves.toBeUndefined();

    expect(failingSink.write).toHaveBeenCalledTimes(1);
    expect(passingSink.write).toHaveBeenCalledTimes(1);
  });
});
