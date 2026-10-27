import { describe, expect, it } from "vitest";
import OpenAI from "openai";

import { classifyLlmProviderFailure } from "../../src/shared/infra/llm/llmProviderFailureClassification.js";
import { ProviderHttpError } from "../../src/shared/infra/llm/providerErrors.js";
import { ProviderRequestTimeoutError } from "../../src/shared/infra/llm/providerTimeouts.js";
import { McpCredentialsRejectedError } from "../../src/modules/externalSkills/domain.js";

/**
 * A real OpenAI SDK error instance — what every call through `openaiProvider.ts`
 * actually throws. `any[]` on the constructor sidesteps each subclass's own literal
 * status type (`NotFoundError` takes exactly `404`, etc.); the return type keeps every
 * call site typed as a plain `OpenAI.APIError`.
 */
const openAIError = (
  Ctor: new (...args: any[]) => InstanceType<typeof OpenAI.APIError>,
  status: number | undefined,
  body: Record<string, unknown>,
): InstanceType<typeof OpenAI.APIError> => new Ctor(status, body, "message", new Headers());

describe("classifyLlmProviderFailure", () => {
  describe("a real OpenAI SDK error (what openaiProvider.ts actually throws)", () => {
    it("classifies an Azure undeployed-model 404 as model_unavailable", () => {
      const error = openAIError(OpenAI.NotFoundError, 404, { code: "DeploymentNotFound" });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "model_unavailable",
        status: 404,
        code: "DeploymentNotFound",
      });
    });

    it("classifies OpenAI's own model_not_found code as model_unavailable even without a 404 status", () => {
      const error = openAIError(OpenAI.APIError, undefined, { code: "model_not_found" });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "model_unavailable",
        code: "model_not_found",
      });
    });

    it("classifies a 401 as auth_rejected via the existing credential detector", () => {
      const error = openAIError(OpenAI.AuthenticationError, 401, { code: "invalid_api_key" });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "auth_rejected",
        status: 401,
        code: "invalid_api_key",
      });
    });

    it("classifies a 429 as rate_limited", () => {
      const error = openAIError(OpenAI.RateLimitError, 429, { code: "rate_limit_exceeded" });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "rate_limited",
        status: 429,
        code: "rate_limit_exceeded",
      });
    });

    it("classifies a 5xx as provider_unavailable", () => {
      const error = openAIError(OpenAI.InternalServerError, 503, {});
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "provider_unavailable",
        status: 503,
        code: undefined,
      });
    });

    it("classifies another 4xx (e.g. malformed request) as provider_rejected", () => {
      const error = openAIError(OpenAI.BadRequestError, 400, { code: "invalid_request_error" });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "provider_rejected",
        status: 400,
        code: "invalid_request_error",
      });
    });

    it("classifies a connection failure (APIConnectionError wrapping an undici ECONNREFUSED) as provider_unavailable", () => {
      const networkError = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      const error = new OpenAI.APIConnectionError({ message: "Connection error.", cause: networkError });
      expect(classifyLlmProviderFailure(error)).toEqual({
        kind: "provider_unavailable",
        code: "ECONNREFUSED",
      });
    });

    it("returns null for an abort/timeout error with no status or code of its own (e.g. APIUserAbortError)", () => {
      // Passes the known-provider-type gate, but carries nothing to classify by shape.
      // A caller that needs to distinguish its own timeout from this does so at its own
      // layer (see TurnPlanCoordinator's failureSource), not by teaching this classifier
      // about one specific abort path.
      expect(classifyLlmProviderFailure(new OpenAI.APIUserAbortError())).toBeNull();
    });
  });

  it("classifies a raw fetch-style ProviderHttpError 403 (Gemini/Claude) as auth_rejected", () => {
    const error = new ProviderHttpError({ provider: "Claude", operation: "messages", status: 403 });
    const result = classifyLlmProviderFailure(error);
    expect(result?.kind).toBe("auth_rejected");
    expect(result?.status).toBe(401); // ProviderHttpError normalizes 403 auth failures to 401.
  });

  it("classifies a provider request timeout as provider_unavailable", () => {
    const error = new ProviderRequestTimeoutError("OpenAI chat completion", 30_000);
    expect(classifyLlmProviderFailure(error)).toEqual({ kind: "provider_unavailable" });
  });

  it("never carries message content", () => {
    const error = openAIError(OpenAI.NotFoundError, 404, { code: "DeploymentNotFound" });
    Object.assign(error, { message: "customer prompt leaked here" });
    const result = classifyLlmProviderFailure(error);
    expect(result).not.toHaveProperty("message");
    expect(JSON.stringify(result)).not.toContain("customer prompt leaked here");
  });

  it("filters a non-machine-shaped code (prose a provider echoed back) out of the result", () => {
    const error = openAIError(OpenAI.BadRequestError, 400, { code: "customer jane@example.org rejected" });
    expect(classifyLlmProviderFailure(error)).toEqual({ kind: "provider_rejected", status: 400, code: undefined });
  });

  describe("walking the .cause chain", () => {
    /** Mirrors `RoutineActivationFailure`: a plain Error whose own shape carries no provider signal. */
    class WrappingFailure extends Error {
      constructor(message: string, cause: unknown) {
        super(message, { cause });
      }
    }

    it("classifies a RoutineActivationFailure-shaped wrapper by its cause (the incident's first failure)", () => {
      const providerError = openAIError(OpenAI.NotFoundError, 404, { code: "DeploymentNotFound" });
      const wrapped = new WrappingFailure("Routine selection failed", providerError);
      expect(classifyLlmProviderFailure(wrapped)).toEqual({
        kind: "model_unavailable",
        status: 404,
        code: "DeploymentNotFound",
      });
    });

    it("classifies up to 3 cause hops deep", () => {
      const providerError = openAIError(OpenAI.RateLimitError, 429, { code: "rate_limit_exceeded" });
      const wrapped = new WrappingFailure("l1", new WrappingFailure("l2", new WrappingFailure("l3", providerError)));
      expect(classifyLlmProviderFailure(wrapped)).toEqual({
        kind: "rate_limited",
        status: 429,
        code: "rate_limit_exceeded",
      });
    });

    it("does not classify a cause buried deeper than the bound", () => {
      const providerError = openAIError(OpenAI.RateLimitError, 429, { code: "rate_limit_exceeded" });
      const tooDeep = new WrappingFailure("l1", new WrappingFailure("l2", new WrappingFailure("l3", new WrappingFailure("l4", providerError))));
      expect(classifyLlmProviderFailure(tooDeep)).toBeNull();
    });

    it("stops at a cause cycle instead of looping forever", () => {
      const cyclic: { cause?: unknown } = new Error("cyclic");
      cyclic.cause = cyclic;
      expect(classifyLlmProviderFailure(cyclic)).toBeNull();
    });

    it("prefers the top-level error's own classification over its cause", () => {
      const cause = openAIError(OpenAI.NotFoundError, 404, { code: "DeploymentNotFound" });
      const wrapped = Object.assign(openAIError(OpenAI.AuthenticationError, 401, { code: "invalid_api_key" }), { cause });
      expect(classifyLlmProviderFailure(wrapped)?.kind).toBe("auth_rejected");
    });

    it("returns null when nothing in the chain is a known provider error type", () => {
      expect(classifyLlmProviderFailure(new WrappingFailure("l1", new Error("boom")))).toBeNull();
    });

    it("still classifies a raw credential error by itself, computed before AppError normalization wraps it", async () => {
      const { normalizeProviderCredentialError } = await import("../../src/shared/infra/llm/providerErrors.js");
      const rawCredentialError = openAIError(OpenAI.AuthenticationError, 401, { code: "invalid_api_key" });
      // The classification the caller must use: computed on the raw error, before
      // normalizeProviderCredentialError rebuilds it into an AppError with no cause
      // chain back to the original. Classifying the normalized AppError loses the signal.
      expect(classifyLlmProviderFailure(rawCredentialError)?.kind).toBe("auth_rejected");
      const normalized = normalizeProviderCredentialError(rawCredentialError);
      expect(classifyLlmProviderFailure(normalized)).toBeNull();
    });
  });

  describe("negative cases: an unrelated error shaped like a provider error, but not one", () => {
    it("does not classify a bare 404 object — a REST client's own 404 looks identical to a provider one", () => {
      expect(classifyLlmProviderFailure({ status: 404, code: "DeploymentNotFound" })).toBeNull();
    });

    it("does not classify a Postgres-shaped ECONNREFUSED as a provider outage", () => {
      const pgError = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      expect(classifyLlmProviderFailure(pgError)).toBeNull();
    });

    it("does not classify an MCP credential rejection (401) as an LLM auth failure", () => {
      expect(classifyLlmProviderFailure(new McpCredentialsRejectedError(401))).toBeNull();
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
  });
});
