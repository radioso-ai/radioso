import { describe, expect, it, vi } from "vitest";

import { buildWorkspaceProviderCredentialsService } from "../../src/app/server/dependencyBuilders.js";
import type { Env } from "../../src/app/config/env.js";
import type { AuditPort } from "../../src/modules/audit/contracts/index.js";
import { InMemoryWorkspaceProviderCredentialsRepository } from "../support/fakes.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const buildAudit = (): AuditPort => ({
  async record() {},
  async getLatestSuccessfulChatAnswerMetadata() {
    return null;
  },
  async updateChatAnswerSuggestions() {},
});

const baseRepositories = () =>
  ({
    workspaceProviderCredentialsRepository: new InMemoryWorkspaceProviderCredentialsRepository(),
  }) as Parameters<typeof buildWorkspaceProviderCredentialsService>[0]["repositories"];

const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    CONNECTOR_ENCRYPTION_KEY: TEST_KEY,
    ...overrides,
  }) as Env;

describe("workspace provider credentials boot policy", () => {
  it("registers the service as configured when CONNECTOR_ENCRYPTION_KEY is set", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any;
    const service = buildWorkspaceProviderCredentialsService({
      auditService: buildAudit(),
      env: baseEnv(),
      logger,
      repositories: baseRepositories(),
    });

    expect(service.isEncryptionConfigured()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns operator when CONNECTOR_ENCRYPTION_KEY is missing, but does not throw", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any;
    const service = buildWorkspaceProviderCredentialsService({
      auditService: buildAudit(),
      env: baseEnv({ CONNECTOR_ENCRYPTION_KEY: undefined }),
      logger,
      repositories: baseRepositories(),
    });

    expect(service.isEncryptionConfigured()).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.warn.mock.calls[0];
    expect(message).toMatch(/encryption is not configured/i);
    expect(payload).toMatchObject({ remediation: expect.stringContaining("CONNECTOR_ENCRYPTION_KEY") });
  });

  it("attaches a decrypt-error logger that fires when ciphertext cannot be read", async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any;
    const repositories = baseRepositories();
    const writerService = buildWorkspaceProviderCredentialsService({
      auditService: buildAudit(),
      env: baseEnv(),
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      repositories,
    });
    await writerService.setApiKey({
      workspaceId: "ws-1",
      provider: "openai",
      apiKey: "key",
      actor: { accountId: "acc-1" },
    });

    const rotatedKey = Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64");
    const readerService = buildWorkspaceProviderCredentialsService({
      auditService: buildAudit(),
      env: baseEnv({ CONNECTOR_ENCRYPTION_KEY: rotatedKey }),
      logger,
      repositories,
    });

    const failure = await readerService.getApiKey("ws-1", "openai").catch((error) => error);
    expect(failure).toMatchObject({
      statusCode: 503,
      code: "provider_misconfigured",
      details: {
        providerIssue: "configuration_invalid",
        kind: "credential_unreadable",
        provider: "openai",
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        remediation: expect.stringContaining("Re-enter the API key"),
      }),
      "Workspace provider credential decrypt failed",
    );
  });
});
