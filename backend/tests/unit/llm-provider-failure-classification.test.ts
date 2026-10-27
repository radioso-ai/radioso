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

  describe("walking the .cause chain", () => {
    /** Mirrors `RoutineActivationFailure`: a plain Error whose own shape carries no provider signal. */
    class WrappingFailure extends Error {
      constructor(message: string, cause: unknown) {
        super(message, { cause });
      }
    }

    it("classifies a RoutineActivationFailure-shaped wrapper by its cause (the incident's first failure)", () => {
      const providerError = Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" });
      const wrapped = new WrappingFailure("Routine selection failed", providerError);
      expect(classifyLlmProviderFailure(wrapped)).toEqual({
        kind: "model_unavailable",
        status: 404,
        code: "DeploymentNotFound",
      });
    });

    it("classifies up to 3 cause hops deep", () => {
      const providerError = { status: 429, code: "rate_limit_exceeded" };
      const wrapped = new WrappingFailure("l1", new WrappingFailure("l2", new WrappingFailure("l3", providerError)));
      expect(classifyLlmProviderFailure(wrapped)).toEqual({
        kind: "rate_limited",
        status: 429,
        code: "rate_limit_exceeded",
      });
    });

    it("does not classify a cause buried deeper than the bound", () => {
      const providerError = { status: 429, code: "rate_limit_exceeded" };
      const tooDeep = new WrappingFailure("l1", new WrappingFailure("l2", new WrappingFailure("l3", new WrappingFailure("l4", providerError))));
      expect(classifyLlmProviderFailure(tooDeep)).toBeNull();
    });

    it("stops at a cause cycle instead of looping forever", () => {
      const cyclic: { cause?: unknown } = new Error("cyclic");
      cyclic.cause = cyclic;
      expect(classifyLlmProviderFailure(cyclic)).toBeNull();
    });

    it("prefers the top-level error's own classification over its cause", () => {
      const cause = { status: 404, code: "DeploymentNotFound" };
      const wrapped = Object.assign(new Error("rejected"), { status: 401, code: "invalid_api_key", cause });
      expect(classifyLlmProviderFailure(wrapped)?.kind).toBe("auth_rejected");
    });

    it("returns null when nothing in the chain carries a provider shape", () => {
      expect(classifyLlmProviderFailure(new WrappingFailure("l1", new Error("boom")))).toBeNull();
    });

    it("still classifies a raw credential error by itself, computed before AppError normalization wraps it", async () => {
      const { normalizeProviderCredentialError } = await import("../../src/shared/infra/llm/providerErrors.js");
      const rawCredentialError = { status: 401, code: "invalid_api_key" };
      // The classification the caller must use: computed on the raw error, before
      // normalizeProviderCredentialError rebuilds it into an AppError with no cause
      // chain back to the original. Classifying the normalized AppError loses the signal.
      expect(classifyLlmProviderFailure(rawCredentialError)?.kind).toBe("auth_rejected");
      const normalized = normalizeProviderCredentialError(rawCredentialError);
      expect(classifyLlmProviderFailure(normalized)).toBeNull();
    });
  });
});
