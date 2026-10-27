import { describe, expect, it } from "vitest";

import { AppError, isReportableFault, serviceUnavailable, usageLimitExceeded } from "../../src/shared/domain/errors.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";
import { normalizeProviderCredentialError } from "../../src/shared/infra/llm/providerErrors.js";
import { ChatTurnDisconnectAbortError, ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";

describe("isReportableFault", () => {
  it("reports a non-AppError (an unexpected, unclassified failure)", () => {
    expect(isReportableFault(new Error("boom"))).toBe(true);
    expect(isReportableFault({ status: 404, code: "DeploymentNotFound" })).toBe(true);
  });

  it("reports a platform misconfiguration (ProviderConfigurationError, AppError 503)", () => {
    expect(isReportableFault(new ProviderConfigurationError("No API key configured", { kind: "missing_api_key" }))).toBe(true);
  });

  it("reports a normalized provider-credential rejection (AppError 503)", () => {
    const normalized = normalizeProviderCredentialError({ status: 401, code: "invalid_api_key" });
    expect(normalized).toBeInstanceOf(AppError);
    expect(isReportableFault(normalized)).toBe(true);
  });

  it("reports any other 5xx AppError", () => {
    expect(isReportableFault(serviceUnavailable("downstream dependency is down"))).toBe(true);
    expect(isReportableFault(new AppError(500, "internal_error", "unexpected"))).toBe(true);
  });

  it("does not report a usage-limit AppError (429, a client outcome)", () => {
    expect(isReportableFault(usageLimitExceeded("Monthly message limit reached"))).toBe(false);
  });

  it("does not report a validation AppError (400)", () => {
    expect(isReportableFault(new AppError(400, "bad_request", "Invalid request"))).toBe(false);
  });

  it("does not report a superseded turn (409, ChatTurnSupersededError)", () => {
    expect(isReportableFault(new ChatTurnSupersededError("conv_1", "rendering"))).toBe(false);
  });

  it("does not report a disconnect-abort turn despite its 500 status (an expected client-driven outcome)", () => {
    const error = new ChatTurnDisconnectAbortError("conv_1", "rendering");
    expect(error.statusCode).toBe(500);
    expect(isReportableFault(error)).toBe(false);
  });

  it("marks disconnect-abort as an expected outcome by a typed property, not by class or message", () => {
    const error = new ChatTurnDisconnectAbortError("conv_1", "rendering");
    expect(error.isExpectedOutcome).toBe(true);
  });

  it("defaults isExpectedOutcome to false for a plain AppError", () => {
    expect(new AppError(503, "service_unavailable", "x").isExpectedOutcome).toBe(false);
  });
});
