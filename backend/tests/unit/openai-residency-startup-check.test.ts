import { describe, expect, it, vi } from "vitest";

const embeddingsCreateMock = vi.fn(async () => ({}));
const chatCompletionsCreateMock = vi.fn(async () => ({}));
const responsesCreateMock = vi.fn(async () => ({}));
let capturedClientOptions: { apiKey?: string; baseURL?: string }[] = [];

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: embeddingsCreateMock };
    chat = { completions: { create: chatCompletionsCreateMock } };
    responses = { create: responsesCreateMock };
    constructor(options: { apiKey?: string; baseURL?: string }) {
      capturedClientOptions.push(options);
    }
  },
}));

import {
  AzureOpenAIDeploymentRejectedError,
  OpenAIRegionalEndpointRejectedError,
  runOpenAIResidencyStartupCheck,
} from "../../src/runtime/openAIResidencyStartupCheck.js";
import { getEnv } from "../../src/app/config/env.js";

// Chat, rewrite, and rerank are kept on claude here so the single-target (embeddings-only) tests
// below stay focused on exactly one probe call, matching their pre-Azure shape. Dedicated tests
// further down cover chat/rewrite/rerank probing (including the chat+rewrite dedupe, rerank's
// separate "responses" surface, and Azure.
const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "env-openai-key",
  ANTHROPIC_API_KEY: "env-claude-key",
  LLM_CHAT_PROVIDER: "claude",
  LLM_REWRITE_PROVIDER: "claude",
  LLM_RERANK_PROVIDER: "claude",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
} as const;

const buildLogger = () => ({ info: vi.fn(), warn: vi.fn() });
const noopCallbacks = () => ({
  callChatCompletion: vi.fn(async () => ({})),
  callResponses: vi.fn(async () => ({})),
});

/** An API failure the way the OpenAI SDK throws it: an Error carrying the HTTP status and error code. */
const apiError = (fields: { status: number; code?: string | null }) =>
  Object.assign(new Error(`OpenAI API error ${fields.status}`), fields);

describe("runOpenAIResidencyStartupCheck", () => {
  it("skips with no call at the default (global, no Azure) platform endpoint", async () => {
    const env = getEnv({ ...baseEnv });
    const callEmbeddings = vi.fn();
    const callChatCompletion = vi.fn();
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings, callChatCompletion });

    expect(outcome).toBe("skipped");
    expect(callEmbeddings).not.toHaveBeenCalled();
    expect(callChatCompletion).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips with no call when there is no platform OpenAI key, even with a regional residency set", async () => {
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      ANTHROPIC_API_KEY: "env-claude-key",
      LLM_PROVIDER: "claude",
      LLM_EMBEDDING_PROVIDER: "claude",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    const callEmbeddings = vi.fn();
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings });

    expect(outcome).toBe("skipped");
    expect(callEmbeddings).not.toHaveBeenCalled();
  });

  it("calls the regional embeddings endpoint with the resolved model and logs ok on success", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const callEmbeddings = vi.fn(async () => ({}));
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings, ...noopCallbacks() });

    expect(outcome).toBe("ok");
    expect(callEmbeddings).toHaveBeenCalledWith({
      apiKey: "env-openai-key",
      endpoint: { kind: "openai", residency: "eu" },
      model: "text-embedding-3-small",
    });
    expect(logger.info).toHaveBeenCalledWith({ openai: "eu", probe: "ok" }, "Resolved provider residency");
    expect(logger.warn).not.toHaveBeenCalled();

    const serialized = JSON.stringify(logger.info.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("env-openai-key");
  });

  it("throws OpenAIRegionalEndpointRejectedError and never logs ok/warn on a definitive 401 rejection", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 401, code: null });
    });
    const logger = buildLogger();

    await expect(
      runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings, ...noopCallbacks() }),
    ).rejects.toThrow(OpenAIRegionalEndpointRejectedError);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws on a definitive 403 rejection", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "us" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 403 });
    });

    await expect(
      runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings, ...noopCallbacks() }),
    ).rejects.toThrow(OpenAIRegionalEndpointRejectedError);
  });

  it("throws on a definitive 404 rejection (the model isn't offered in this region)", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 404 });
    });

    await expect(
      runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings, ...noopCallbacks() }),
    ).rejects.toThrow(OpenAIRegionalEndpointRejectedError);
  });

  it("the rejection error names the residency, the model, the capability, and OPENAI_DATA_RESIDENCY", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 401 });
    });

    let failure: Error | undefined;
    try {
      await runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings, ...noopCallbacks() });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("OPENAI_DATA_RESIDENCY");
    expect(failure?.message).toContain("eu");
    expect(failure?.message).toContain("text-embedding-3-small");
    expect(failure?.message).toContain("embeddings");
  });

  it("logs a warn and returns transient_failure on a network error, timeout, 429, or 5xx", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    for (const rejection of [
      new Error("fetch failed"),
      apiError({ status: 429 }),
      apiError({ status: 500 }),
      apiError({ status: 503 }),
    ]) {
      const logger = buildLogger();
      const callEmbeddings = vi.fn(async () => {
        throw rejection;
      });

      const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings, ...noopCallbacks() });

      expect(outcome).toBe("transient_failure");
      expect(logger.warn).toHaveBeenCalledWith({ openai: "eu", probe: "transient_failure" }, "Resolved provider residency");
      expect(logger.info).not.toHaveBeenCalled();
    }
  });

  it("defaults to a call through the pinned client factory, reaching the exact regional host", async () => {
    capturedClientOptions = [];
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger });

    expect(outcome).toBe("ok");
    expect(capturedClientOptions).toContainEqual(
      expect.objectContaining({ apiKey: "env-openai-key", baseURL: "https://eu.api.openai.com/v1" }),
    );
    expect(embeddingsCreateMock).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: "x" });
  });

  describe("chat, rewrite, and rerank probing", () => {
    it("probes chat and rewrite via one deduped chat-completion call when they share a model", async () => {
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-openai-key",
        LLM_RERANK_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "env-claude-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        OPENAI_DATA_RESIDENCY: "eu",
        OPENAI_CHAT_MODEL: "gpt-5.4-mini",
        OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      });
      const callEmbeddings = vi.fn(async () => ({}));
      const callChatCompletion = vi.fn(async () => ({}));
      const callResponses = vi.fn(async () => ({}));
      const logger = buildLogger();

      const outcome = await runOpenAIResidencyStartupCheck(env, {
        logger,
        callEmbeddings,
        callChatCompletion,
        callResponses,
      });

      expect(outcome).toBe("ok");
      // LLM_REWRITE_MODEL is unset, so rewrite falls back to OPENAI_CHAT_MODEL — the same model
      // chat resolved to — and both ride the chat_completion surface, so this is one call.
      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      expect(callChatCompletion).toHaveBeenCalledWith({
        apiKey: "env-openai-key",
        endpoint: { kind: "openai", residency: "eu" },
        model: "gpt-5.4-mini",
      });
      expect(callResponses).not.toHaveBeenCalled();
    });

    it("probes rerank via responses.create, never deduped with chat even when they share a model", async () => {
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-openai-key",
        LLM_REWRITE_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "env-claude-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        OPENAI_DATA_RESIDENCY: "eu",
        OPENAI_CHAT_MODEL: "gpt-5.4-mini",
        OPENAI_RERANK_MODEL: "gpt-5.4-mini",
        OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      });
      const callEmbeddings = vi.fn(async () => ({}));
      const callChatCompletion = vi.fn(async () => ({}));
      const callResponses = vi.fn(async () => ({}));

      const outcome = await runOpenAIResidencyStartupCheck(env, {
        logger: buildLogger(),
        callEmbeddings,
        callChatCompletion,
        callResponses,
      });

      expect(outcome).toBe("ok");
      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      expect(callChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-5.4-mini" }),
      );
      expect(callResponses).toHaveBeenCalledTimes(1);
      expect(callResponses).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-5.4-mini" }),
      );
    });

    it("names every capability on a shared chat_completion target when it is rejected", async () => {
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-openai-key",
        LLM_RERANK_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "env-claude-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        OPENAI_DATA_RESIDENCY: "eu",
        OPENAI_CHAT_MODEL: "gpt-5.4-mini",
      });
      const callEmbeddings = vi.fn(async () => ({}));
      const callChatCompletion = vi.fn(async () => {
        throw apiError({ status: 404 });
      });

      let failure: Error | undefined;
      try {
        await runOpenAIResidencyStartupCheck(env, {
          logger: buildLogger(),
          callEmbeddings,
          callChatCompletion,
          callResponses: vi.fn(async () => ({})),
        });
      } catch (error) {
        failure = error as Error;
      }

      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(OpenAIRegionalEndpointRejectedError);
      expect(failure?.message).toContain("gpt-5.4-mini");
      expect(failure?.message).toContain("chat");
      expect(failure?.message).toContain("rewrite");
    });

    it("skips the chat/rewrite/rerank probes when they all resolve to a different provider", async () => {
      const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
      const callEmbeddings = vi.fn(async () => ({}));
      const { callChatCompletion, callResponses } = noopCallbacks();

      const outcome = await runOpenAIResidencyStartupCheck(env, {
        logger: buildLogger(),
        callEmbeddings,
        callChatCompletion,
        callResponses,
      });

      expect(outcome).toBe("ok");
      expect(callChatCompletion).not.toHaveBeenCalled();
      expect(callResponses).not.toHaveBeenCalled();
    });
  });

  describe("Azure OpenAI endpoint", () => {
    const azureBaseUrl = "https://radioso-eu-1.openai.azure.com/openai/v1";

    it("probes embeddings, chat/rewrite, and rerank when AZURE_OPENAI_ENDPOINT is set, even at the default (global) residency", async () => {
      // Mirrors the real EU Azure stack: no EU Data Zone quota for a nano rerank model, so chat
      // and rerank share gpt-5.4-mini — on two different surfaces, both must be probed.
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-azure-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        AZURE_OPENAI_ENDPOINT: azureBaseUrl,
        OPENAI_CHAT_MODEL: "gpt-5.4-mini",
        OPENAI_RERANK_MODEL: "gpt-5.4-mini",
        OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      });
      const callEmbeddings = vi.fn(async () => ({}));
      const callChatCompletion = vi.fn(async () => ({}));
      const callResponses = vi.fn(async () => ({}));
      const logger = buildLogger();

      const outcome = await runOpenAIResidencyStartupCheck(env, {
        logger,
        callEmbeddings,
        callChatCompletion,
        callResponses,
      });

      expect(outcome).toBe("ok");
      expect(callEmbeddings).toHaveBeenCalledWith({
        apiKey: "env-azure-key",
        endpoint: { kind: "azure", baseUrl: azureBaseUrl },
        model: "text-embedding-3-small",
      });
      expect(callChatCompletion).toHaveBeenCalledWith({
        apiKey: "env-azure-key",
        endpoint: { kind: "azure", baseUrl: azureBaseUrl },
        model: "gpt-5.4-mini",
      });
      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      expect(callResponses).toHaveBeenCalledWith({
        apiKey: "env-azure-key",
        endpoint: { kind: "azure", baseUrl: azureBaseUrl },
        model: "gpt-5.4-mini",
      });
      expect(callResponses).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        { openai: "azure", azureHost: "radioso-eu-1.openai.azure.com", probe: "ok" },
        "Resolved provider residency",
      );
    });

    it("throws AzureOpenAIDeploymentRejectedError naming AZURE_OPENAI_ENDPOINT, the deployment, and the deployment-name convention on a 404", async () => {
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-azure-key",
        LLM_CHAT_PROVIDER: "claude",
        LLM_REWRITE_PROVIDER: "claude",
        LLM_RERANK_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "env-claude-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        AZURE_OPENAI_ENDPOINT: azureBaseUrl,
        OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      });
      const callEmbeddings = vi.fn(async () => {
        throw apiError({ status: 404, code: "DeploymentNotFound" });
      });

      let failure: Error | undefined;
      try {
        await runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings, ...noopCallbacks() });
      } catch (error) {
        failure = error as Error;
      }

      expect(failure).toBeInstanceOf(AzureOpenAIDeploymentRejectedError);
      expect(failure?.message).toContain("AZURE_OPENAI_ENDPOINT");
      expect(failure?.message).toContain("text-embedding-3-small");
      expect(failure?.message).toContain("deployment name equal to the model name");
    });

    it("warns and returns transient_failure on a 5xx from Azure, never throwing", async () => {
      const env = getEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
        OPENAI_API_KEY: "env-azure-key",
        LLM_CHAT_PROVIDER: "claude",
        LLM_REWRITE_PROVIDER: "claude",
        LLM_RERANK_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "env-claude-key",
        SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
        AZURE_OPENAI_ENDPOINT: azureBaseUrl,
      });
      const callEmbeddings = vi.fn(async () => {
        throw apiError({ status: 503 });
      });
      const logger = buildLogger();

      const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings, ...noopCallbacks() });

      expect(outcome).toBe("transient_failure");
      expect(logger.warn).toHaveBeenCalledWith(
        { openai: "azure", azureHost: "radioso-eu-1.openai.azure.com", probe: "transient_failure" },
        "Resolved provider residency",
      );
    });
  });
});
