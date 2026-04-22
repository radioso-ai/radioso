import { describe, expect, it } from "vitest";

import { createRequestCorrelation, mergeCorrelation } from "../../src/shared/observability/telemetry/correlation.js";
import { redactRecord, redactedValue } from "../../src/shared/observability/telemetry/redactionPolicy.js";

describe("telemetry redaction and correlation helpers", () => {
  it("redacts sensitive nested values", () => {
    const redacted = redactRecord({
      apiKey: "secret",
      prompt: "private prompt",
      nested: {
        token: "abc",
        ok: "value",
      },
      list: [
        {
          sourceContent: "private document text",
        },
      ],
    });

    expect(redacted).toEqual({
      apiKey: redactedValue(),
      prompt: redactedValue(),
      nested: {
        token: redactedValue(),
        ok: "value",
      },
      list: [
        {
          sourceContent: redactedValue(),
        },
      ],
    });
  });

  it("builds request correlation from request-like inputs", () => {
    const correlation = createRequestCorrelation({
      id: 42,
      method: "GET",
      originalUrl: "/api/v1/settings/retrieval",
      header(name) {
        return name === "x-workspace-id" ? "workspace-123" : undefined;
      },
    });

    expect(correlation).toEqual({
      requestId: "42",
      workspaceId: "workspace-123",
      route: "/api/v1/settings/retrieval",
      method: "GET",
    });
  });

  it("merges correlation sources without keeping empty values", () => {
    expect(
      mergeCorrelation(
        { requestId: "req-1", workspaceId: "" },
        { conversationId: "conv-1" },
      ),
    ).toEqual({
      requestId: "req-1",
      conversationId: "conv-1",
    });
  });
});
