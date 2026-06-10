import express, { Router, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ConfigFieldDefinition, ConnectorContext, ConnectorPlugin } from "@radioso/connector-api";
import { ConnectorRegistry } from "../../../src/modules/connectors/services/connectorRegistry.js";

/** Minimal fake plugin for testing the registry. */
const createFakePlugin = (overrides: Partial<ConnectorPlugin> = {}): ConnectorPlugin => ({
  id: overrides.id ?? "fake",
  name: overrides.name ?? "Fake Connector",
  description: overrides.description ?? "A test connector",
  configSchema: overrides.configSchema ?? (() => [
    { key: "api_key", label: "API Key", type: "secret", required: true },
    { key: "channel_id", label: "Channel ID", type: "text", required: true },
  ] satisfies ConfigFieldDefinition[]),
  migrate: overrides.migrate ?? (async () => {}),
  initialize: overrides.initialize ?? (async () => {}),
  shutdown: overrides.shutdown ?? (async () => {}),
  getWebhookPath: overrides.getWebhookPath ?? (() => "/api/connectors/fake/:workspaceId/webhook"),
  uniqueChannelField: overrides.uniqueChannelField ?? (() => "channel_id"),
  validateConfig: overrides.validateConfig ?? (() => []),
  ...(overrides.syncNow ? { syncNow: overrides.syncNow } : {}),
});

describe("ConnectorRegistry", () => {
  it("registers a plugin and lists it", () => {
    const registry = new ConnectorRegistry();
    const plugin = createFakePlugin();
    registry.register(plugin);

    const plugins = registry.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("fake");
    expect(plugins[0].name).toBe("Fake Connector");
  });

  it("throws when registering duplicate plugin id", () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ id: "dup" }));
    expect(() => registry.register(createFakePlugin({ id: "dup" }))).toThrow(/already registered/i);
  });

  it("retrieves a plugin by id", () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ id: "alpha" }));
    registry.register(createFakePlugin({ id: "beta" }));

    expect(registry.getPlugin("alpha")?.id).toBe("alpha");
    expect(registry.getPlugin("beta")?.id).toBe("beta");
    expect(registry.getPlugin("gamma")).toBeUndefined();
  });

  it("runs migrations for all registered plugins", async () => {
    const migrated: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "a",
      migrate: async () => { migrated.push("a"); },
    }));
    registry.register(createFakePlugin({
      id: "b",
      migrate: async () => { migrated.push("b"); },
    }));

    await registry.runMigrations({} as any);
    expect(migrated).toEqual(["a", "b"]);
  });

  it("initializes and shuts down all registered plugins", async () => {
    const events: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "x",
      initialize: async () => { events.push("init-x"); },
      shutdown: async () => { events.push("shutdown-x"); },
    }));

    const context = {
      db: {} as any,
      logger: { info: () => {}, error: () => {}, warn: () => {} } as any,
      chat: { answer: async () => ({ conversationId: "conversation-1", answer: "ok" }) } as any,
      ingestion: {
        ingest: async () => ({ documentId: "doc-1", status: "queued" }),
        deleteByExternalId: async () => false,
      } as any,
    } satisfies Pick<ConnectorContext, "db" | "logger" | "chat" | "ingestion">;

    await registry.initializeAll(context);
    expect(events).toContain("init-x");

    await registry.shutdownAll();
    expect(events).toContain("shutdown-x");
  });

  it("scopes plugin HTTP mounts under the connector id", async () => {
    const registry = new ConnectorRegistry();
    const mountHandler = vi.fn((_req: Request, res: Response) => res.status(204).end());
    registry.register(createFakePlugin({
      id: "scoped",
      initialize: async (context) => {
        const router = Router({ mergeParams: true });
        router.post("/", mountHandler);
        context.http.mount("/:workspaceId/webhook", router);
      },
    }));

    await registry.initializeAll({
      db: {} as any,
      logger: { info: () => {}, error: () => {}, warn: () => {} } as any,
      chat: { answer: async () => ({ conversationId: "conversation-1", answer: "ok" }) } as any,
      ingestion: {
        ingest: async () => ({ documentId: "doc-1", status: "queued" }),
        deleteByExternalId: async () => false,
        ensureSource: async () => ({ id: "src-1" }),
      } as any,
    });

    const app = express();
    app.use("/api/connectors", registry.getRouter());

    await request(app).post("/api/connectors/scoped/workspace-1/webhook").expect(204);
    expect(mountHandler).toHaveBeenCalledTimes(1);
  });

  it("continues initializing other plugins if one fails", async () => {
    const events: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "fails",
      initialize: async () => { throw new Error("boom"); },
    }));
    registry.register(createFakePlugin({
      id: "succeeds",
      initialize: async () => { events.push("init-succeeds"); },
    }));

    const context = {
      db: {} as any,
      logger: { info: () => {}, error: () => {}, warn: () => {} } as any,
      chat: { answer: async () => ({ conversationId: "conversation-1", answer: "ok" }) } as any,
      ingestion: {
        ingest: async () => ({ documentId: "doc-1", status: "queued" }),
        deleteByExternalId: async () => false,
      } as any,
    } satisfies Pick<ConnectorContext, "db" | "logger" | "chat" | "ingestion">;

    // Should not throw
    await registry.initializeAll(context);
    expect(events).toContain("init-succeeds");
  });

  it("requires remediation for legacy plaintext secrets after encryption is enabled", async () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      configSchema: () => [
        { key: "api_key", label: "API Key", type: "secret", required: true },
      ],
    }));
    registry.setEncryptionKey(Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));

    const db = {
      query: async <T>() => [{ enabled: true, config_data: { api_key: "legacy-plaintext-token" } } as T],
    };

    await expect(registry.getDecryptedConfig(db as any, "workspace-1", "fake")).resolves.toBeNull();
  });

  it("includes connector sync state in connector detail", async () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin());

    const db = {
      query: vi.fn(async <T>(sql: string) => {
        if (sql.includes("FROM connector_configs")) {
          return [{
            enabled: true,
            config_data: { channel_id: "alpha" },
            error_status: "last_failed",
          } as T];
        }
        if (sql.includes("FROM connector_sync_state")) {
          return [{
            backfill_completed_at: "2026-05-20T12:00:00.000Z",
            sync_requested_at: "2026-05-21T11:58:00.000Z",
            sync_started_at: "2026-05-21T11:59:00.000Z",
            last_run_at: "2026-05-21T12:00:00.000Z",
            last_modified_at: "2026-05-19T12:00:00.000Z",
            last_ingested_count: 7,
          } as T];
        }
        return [];
      }),
    };

    const detail = await registry.getConnectorDetail(db as any, "workspace-1", "fake");

    expect(detail?.syncState).toEqual({
      backfillCompletedAt: "2026-05-20T12:00:00.000Z",
      syncRequestedAt: "2026-05-21T11:58:00.000Z",
      syncStartedAt: "2026-05-21T11:59:00.000Z",
      lastRunAt: "2026-05-21T12:00:00.000Z",
      lastModifiedAt: "2026-05-19T12:00:00.000Z",
      lastIngestedCount: 7,
    });
  });

  it("runs a plugin sync action through the connector contract", async () => {
    const syncNow = vi.fn(async () => ({ accepted: true }));
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ syncNow }));

    const db = {
      query: vi.fn(async <T>() => [{ enabled: true, config_data: { channel_id: "alpha" } } as T]),
    };

    const result = await registry.syncConnector(db as any, "workspace-1", "fake");

    expect(result).toEqual({ kind: "success", accepted: true });
    expect(syncNow).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
  });

  it("reports an already-running sync without starting more work", async () => {
    const syncNow = vi.fn(async () => ({ accepted: false, alreadyRunning: true }));
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ syncNow }));

    const db = {
      query: vi.fn(async <T>() => [{ enabled: true, config_data: { channel_id: "alpha" } } as T]),
    };

    await expect(registry.syncConnector(db as any, "workspace-1", "fake")).resolves.toEqual({
      kind: "already_running",
    });
  });

  it("reports unsupported sync actions without calling connector-specific code", async () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin());

    await expect(registry.syncConnector({ query: vi.fn() } as any, "workspace-1", "fake")).resolves.toEqual({
      kind: "unsupported",
    });
  });
});
