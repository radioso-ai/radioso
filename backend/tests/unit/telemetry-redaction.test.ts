import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";
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

  it("builds request correlation from request-like inputs, naming the route by the pattern it matched", () => {
    const request = {
      id: 42,
      method: "GET",
      baseUrl: "/api/v1/settings",
      params: {},
      originalUrl: "/api/v1/settings/retrieval?search=private",
      header(name: string) {
        return name === "x-workspace-id" ? "workspace-123" : undefined;
      },
    };
    createMatchedRouteRecorder()(request as unknown as Request, {} as Response, () => undefined);
    // Express assigns `req.route` as it dispatches to the matched route.
    (request as { route?: unknown }).route = { path: "/retrieval" };

    expect(createRequestCorrelation(request)).toEqual({
      requestId: "42",
      workspaceId: "workspace-123",
      route: "/api/v1/settings/retrieval",
      method: "GET",
    });
  });

  it("names no route for a request no route matched, rather than its URL", () => {
    const correlation = createRequestCorrelation({
      id: 7,
      method: "GET",
      originalUrl: "/api/v1/auth/invitations/secret-invite-token",
    } as Parameters<typeof createRequestCorrelation>[0]);

    expect(correlation).toEqual({ requestId: "7", method: "GET" });
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
