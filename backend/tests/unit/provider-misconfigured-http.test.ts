import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";

describe("ProviderConfigurationError over HTTP", () => {
  it("becomes a structured 503 instead of a generic 500 internal_error", async () => {
    const app = express();
    app.get("/throw", (_req, _res, next) => {
      next(
        new ProviderConfigurationError(
          'No API key configured for provider "claude". Add a workspace credential or set the matching environment variable.',
          {
            kind: "missing_api_key",
            provider: "claude",
            capability: "chat",
            remediation: "Add a workspace credential at Settings → Credentials, or set ANTHROPIC_API_KEY.",
          },
        ),
      );
    });
    app.use(createErrorHandler());

    const response = await request(app).get("/throw");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: "provider_misconfigured",
        message: expect.stringContaining("claude"),
        details: {
          providerIssue: "configuration_invalid",
          kind: "missing_api_key",
          provider: "claude",
          capability: "chat",
          remediation: expect.stringContaining("Settings → Credentials"),
        },
      },
    });
  });
});
