import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeTextGenerationClient } from "../../src/shared/infra/llm/claudeProvider.js";
import { GeminiTextGenerationClient } from "../../src/shared/infra/llm/geminiProvider.js";
import {
  isProviderCredentialError,
  ProviderHttpError,
} from "../../src/shared/infra/llm/providerErrors.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

const claudeConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "claude",
  model: "claude-sonnet-4-5",
  apiKey: "test-key",
};

const geminiConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKey: "test-key",
};

const buildAuthRejectionResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const buildStreamingAuthRejectionResponse = (status: number, body: unknown): Response =>
  // Same as buildAuthRejectionResponse: we exercise the non-OK branch before any
  // body parsing happens, so the body itself is read with response.text().
  buildAuthRejectionResponse(status, body);

const restoreFetch = () => {
  vi.restoreAllMocks();
};

afterEach(restoreFetch);

describe("Claude provider auth failures", () => {
  it("complete: throws a ProviderHttpError recognised as a credential error on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildAuthRejectionResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      })),
    );

    const client = new ClaudeTextGenerationClient(claudeConfig);
    const failure = await client.complete({ prompt: "hi" }).catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(isProviderCredentialError(failure)).toBe(true);
    expect(failure).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect(failure.error).toMatchObject({ type: "authentication_error" });
  });

  it("stream: throws a ProviderHttpError recognised as a credential error on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildStreamingAuthRejectionResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      })),
    );

    const client = new ClaudeTextGenerationClient(claudeConfig);
    const stream = client.stream({ prompt: "hi" });
    const failure = await (async () => {
      try {
        for await (const _chunk of stream.textStream) {
          void _chunk;
        }
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(isProviderCredentialError(failure)).toBe(true);
  });
});

describe("Gemini provider auth failures", () => {
  it("complete: normalises an INVALID_ARGUMENT API-key rejection to a credential error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildAuthRejectionResponse(400, {
        error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid" },
      })),
    );

    const client = new GeminiTextGenerationClient(geminiConfig);
    const failure = await client.complete({ prompt: "hi" }).catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(isProviderCredentialError(failure)).toBe(true);
    expect(failure).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect(failure.error).toMatchObject({ status: "INVALID_ARGUMENT" });
  });

  it("complete: recognises a 403 PERMISSION_DENIED as a credential error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildAuthRejectionResponse(403, {
        error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied" },
      })),
    );

    const client = new GeminiTextGenerationClient(geminiConfig);
    const failure = await client.complete({ prompt: "hi" }).catch((error) => error);
    expect(isProviderCredentialError(failure)).toBe(true);
  });

  it("stream: throws a ProviderHttpError recognised as a credential error on an INVALID_ARGUMENT body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildStreamingAuthRejectionResponse(400, {
        error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid" },
      })),
    );

    const client = new GeminiTextGenerationClient(geminiConfig);
    const stream = client.stream({ prompt: "hi" });
    const failure = await (async () => {
      try {
        for await (const _chunk of stream.textStream) {
          void _chunk;
        }
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(isProviderCredentialError(failure)).toBe(true);
  });

  it("complete: leaves non-auth errors as non-credential ProviderHttpError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildAuthRejectionResponse(500, { error: { code: 500, status: "INTERNAL", message: "boom" } })),
    );

    const client = new GeminiTextGenerationClient(geminiConfig);
    const failure = await client.complete({ prompt: "hi" }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(isProviderCredentialError(failure)).toBe(false);
    expect(failure.status).toBe(500);
  });
});
