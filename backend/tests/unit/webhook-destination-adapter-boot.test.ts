import { describe, expect, it, vi } from "vitest";

import { buildWebhookDestinationAdapter } from "../../src/app/server/dependencyBuilders.js";
import type { Env } from "../../src/app/config/env.js";
import type { AuditPort } from "../../src/modules/audit/contracts/index.js";
import { InMemoryWebhookDestinationRepository } from "../support/fakes.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const workspaceId = "11111111-1111-4111-8111-111111111111";

const auditService = (): AuditPort => ({
  async record() {},
  async getLatestSuccessfulChatAnswerMetadata() {
    return null;
  },
  async updateChatAnswerSuggestions() {},
});

const env = (overrides: Partial<Env> = {}): Env =>
  ({
    NODE_ENV: "development",
    CONNECTOR_ENCRYPTION_KEY: TEST_KEY,
    WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: false,
    ...overrides,
  }) as Env;

const repositories = () => ({
  webhookDestinationRepository: new InMemoryWebhookDestinationRepository(),
  routineDefinitionRepository: {
    listPublishedRoutineNamesReferencingDestination: vi.fn(async () => []),
  },
});

describe("webhook destination adapter boot policy", () => {
  it("passes the local loopback webhook exception from runtime env into destination writes", async () => {
    const assertPublicUrl = vi.fn(async () => {
      throw new Error("loopback should bypass public-host validation when explicitly allowed");
    });
    const adapter = buildWebhookDestinationAdapter({
      auditService: auditService(),
      env: env({ WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: true }),
      logger: { warn: vi.fn() },
      repositories: repositories(),
      assertPublicUrl,
    });

    await expect(adapter.create({
      workspaceId,
      name: "local-closer",
      url: "http://127.0.0.1:3001/api/radioso/order",
      actor: { accountId: "account-1" },
    })).resolves.toMatchObject({
      destination: {
        name: "local-closer",
        url: "http://127.0.0.1:3001/api/radioso/order",
      },
    });
    expect(assertPublicUrl).not.toHaveBeenCalled();
  });

  it("allows Docker host webhook destinations when the local exception is on", async () => {
    const assertPublicUrl = vi.fn(async () => {
      throw new Error("host.docker.internal should bypass public-host validation when explicitly allowed");
    });
    const adapter = buildWebhookDestinationAdapter({
      auditService: auditService(),
      env: env({ WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: true }),
      logger: { warn: vi.fn() },
      repositories: repositories(),
      assertPublicUrl,
    });

    await expect(adapter.create({
      workspaceId,
      name: "local-closer",
      url: "http://host.docker.internal:3001/api/radioso/order",
      actor: { accountId: "account-1" },
    })).resolves.toMatchObject({
      destination: {
        name: "local-closer",
        url: "http://host.docker.internal:3001/api/radioso/order",
      },
    });
    expect(assertPublicUrl).not.toHaveBeenCalled();
  });

  it("keeps loopback webhook destinations rejected when the env exception is off", async () => {
    const adapter = buildWebhookDestinationAdapter({
      auditService: auditService(),
      env: env({ WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: false }),
      logger: { warn: vi.fn() },
      repositories: repositories(),
      assertPublicUrl: vi.fn(async () => undefined),
    });

    await expect(adapter.create({
      workspaceId,
      name: "local-closer",
      url: "http://127.0.0.1:3001/api/radioso/order",
      actor: { accountId: "account-1" },
    })).rejects.toThrow(/https/i);
  });
});
