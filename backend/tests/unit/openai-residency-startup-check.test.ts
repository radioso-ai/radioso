import { describe, expect, it, vi } from "vitest";

const embeddingsCreateMock = vi.fn(async () => ({}));
let capturedClientOptions: { apiKey?: string; baseURL?: string } | undefined;

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: embeddingsCreateMock };
    constructor(options: { apiKey?: string; baseURL?: string }) {
      capturedClientOptions = options;
    }
  },
}));

import {
  OpenAIRegionalEndpointRejectedError,
  runOpenAIResidencyStartupCheck,
} from "../../src/runtime/openAIResidencyStartupCheck.js";
import { getEnv } from "../../src/app/config/env.js";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "env-openai-key",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
} as const;

const buildLogger = () => ({ info: vi.fn(), warn: vi.fn() });

/** An API failure the way the OpenAI SDK throws it: an Error carrying the HTTP status and error code. */
const apiError = (fields: { status: number; code?: string | null }) =>
  Object.assign(new Error(`OpenAI API error ${fields.status}`), fields);

describe("runOpenAIResidencyStartupCheck", () => {
  it("skips with no call at the default (global) residency", async () => {
    const env = getEnv({ ...baseEnv });
    const callEmbeddings = vi.fn();
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings });

    expect(outcome).toBe("skipped");
    expect(callEmbeddings).not.toHaveBeenCalled();
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

  it("calls the regional endpoint with the resolved embedding model and logs ok on success", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const callEmbeddings = vi.fn(async () => ({}));
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings });

    expect(outcome).toBe("ok");
    expect(callEmbeddings).toHaveBeenCalledWith({
      apiKey: "env-openai-key",
      residency: "eu",
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

    await expect(runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings })).rejects.toThrow(
      OpenAIRegionalEndpointRejectedError,
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws on a definitive 403 rejection", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "us" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 403 });
    });

    await expect(runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings })).rejects.toThrow(
      OpenAIRegionalEndpointRejectedError,
    );
  });

  it("throws on a definitive 404 rejection (the model isn't offered in this region)", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 404 });
    });

    await expect(runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings })).rejects.toThrow(
      OpenAIRegionalEndpointRejectedError,
    );
  });

  it("the rejection error names the residency, the embedding model, and OPENAI_DATA_RESIDENCY", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const callEmbeddings = vi.fn(async () => {
      throw apiError({ status: 401 });
    });

    let failure: Error | undefined;
    try {
      await runOpenAIResidencyStartupCheck(env, { logger: buildLogger(), callEmbeddings });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("OPENAI_DATA_RESIDENCY");
    expect(failure?.message).toContain("eu");
    expect(failure?.message).toContain("text-embedding-3-small");
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

      const outcome = await runOpenAIResidencyStartupCheck(env, { logger, callEmbeddings });

      expect(outcome).toBe("transient_failure");
      expect(logger.warn).toHaveBeenCalledWith({ openai: "eu", probe: "transient_failure" }, "Resolved provider residency");
      expect(logger.info).not.toHaveBeenCalled();
    }
  });

  it("defaults to a call through the pinned client factory, reaching the exact regional host", async () => {
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", OPENAI_VECTOR_MODEL: "text-embedding-3-small" });
    const logger = buildLogger();

    const outcome = await runOpenAIResidencyStartupCheck(env, { logger });

    expect(outcome).toBe("ok");
    expect(capturedClientOptions).toMatchObject({
      apiKey: "env-openai-key",
      baseURL: "https://eu.api.openai.com/v1",
    });
    expect(embeddingsCreateMock).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: "x" });
  });
});
