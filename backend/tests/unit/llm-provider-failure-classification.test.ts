import { describe, expect, it } from "vitest";

import { classifyLlmProviderFailure } from "../../src/shared/infra/llm/llmProviderFailureClassification.js";
import { ProviderHttpError } from "../../src/shared/infra/llm/providerErrors.js";
import { ProviderRequestTimeoutError } from "../../src/shared/infra/llm/providerTimeouts.js";

describe("classifyLlmProviderFailure", () => {
  it("classifies an Azure undeployed-model 404 as model_unavailable", () => {
    const error = { status: 404, code: "DeploymentNotFound" };
    expect(classifyLlmProviderFailure(error)).toEqual({
      kind: "model_unavailable",
      status: 404,
      code: "DeploymentNotFound",
    });
  });

  it("classifies OpenAI's own model_not_found code as model_unavailable even without a 404 status", () => {
    const error = { code: "model_not_found" };
    expect(classifyLlmProviderFailure(error)).toEqual({
      kind: "model_unavailable",
      code: "model_not_found",
    });
  });

  it("classifies a 401 as auth_rejected via the existing credential detector", () => {
    const error = { status: 401, code: "invalid_api_key" };
    expect(classifyLlmProviderFailure(error)).toEqual({
      kind: "auth_rejected",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("classifies a raw fetch-style ProviderHttpError 403 (Gemini/Claude) as auth_rejected", () => {
    const error = new ProviderHttpError({ provider: "Claude", operation: "messages", status: 403 });
    const result = classifyLlmProviderFailure(error);
    expect(result?.kind).toBe("auth_rejected");
    expect(result?.status).toBe(401); // ProviderHttpError normalizes 403 auth failures to 401.
  });

  it("classifies a 429 as rate_limited", () => {
    expect(classifyLlmProviderFailure({ status: 429, code: "rate_limit_exceeded" })).toEqual({
      kind: "rate_limited",
      status: 429,
      code: "rate_limit_exceeded",
    });
  });

  it("classifies a 5xx as provider_unavailable", () => {
    expect(classifyLlmProviderFailure({ status: 503 })).toEqual({
      kind: "provider_unavailable",
      status: 503,
      code: undefined,
    });
  });

  it("classifies a provider request timeout as provider_unavailable", () => {
    const error = new ProviderRequestTimeoutError("OpenAI chat completion", 30_000);
    expect(classifyLlmProviderFailure(error)).toEqual({ kind: "provider_unavailable" });
  });

  it("classifies a Node network-level connection failure as provider_unavailable", () => {
    expect(classifyLlmProviderFailure({ code: "ECONNREFUSED" })).toEqual({
      kind: "provider_unavailable",
      code: "ECONNREFUSED",
    });
  });

  it("classifies a connection failure reported via .cause.code (undici fetch failures)", () => {
    const error = new TypeError("fetch failed");
    (error as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
    expect(classifyLlmProviderFailure(error)).toEqual({
      kind: "provider_unavailable",
      code: "ECONNRESET",
    });
  });

  it("classifies another 4xx (e.g. malformed request) as provider_rejected", () => {
    expect(classifyLlmProviderFailure({ status: 400, code: "invalid_request_error" })).toEqual({
      kind: "provider_rejected",
      status: 400,
      code: "invalid_request_error",
    });
  });

  it("returns null for a plain application error with no provider shape", () => {
    expect(classifyLlmProviderFailure(new Error("boom"))).toBeNull();
  });

  it("returns null for an AppError-shaped object (statusCode, not status)", () => {
    expect(classifyLlmProviderFailure({ statusCode: 400, code: "bad_request" })).toBeNull();
  });

  it("returns null for non-object throwables", () => {
    expect(classifyLlmProviderFailure("boom")).toBeNull();
    expect(classifyLlmProviderFailure(null)).toBeNull();
    expect(classifyLlmProviderFailure(undefined)).toBeNull();
  });

  it("never carries message content", () => {
    const error = { status: 404, code: "DeploymentNotFound", message: "customer prompt leaked here" };
    const result = classifyLlmProviderFailure(error);
    expect(result).not.toHaveProperty("message");
    expect(JSON.stringify(result)).not.toContain("customer prompt leaked here");
  });
});
