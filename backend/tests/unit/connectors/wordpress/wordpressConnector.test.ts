import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorContext,
  ConnectorIngestionPort,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { WordpressConnector } from "../../../../src/modules/connectors/plugins/wordpress/wordpressConnector.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WordpressConnector.validateConfig", () => {
  const connector = new WordpressConnector();

  it("rejects a site URL without http(s) scheme", () => {
    const issues = connector.validateConfig({
      site_url: "example.com",
      webhook_shared_secret: "x",
    });
    expect(issues.map((i) => i.key)).toContain("site_url");
  });

  it("accepts the push-only setup (companion plugin, no REST credentials)", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
    });
    expect(issues).toEqual([]);
  });

  it("requires username + app password to travel together", () => {
    const onlyUser = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
      wp_username: "alice",
    });
    expect(onlyUser.map((i) => i.key)).toContain("wp_application_password");

    const onlyPassword = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
      wp_application_password: "p",
    });
    expect(onlyPassword.map((i) => i.key)).toContain("wp_username");
  });

  it("requires username + app password when polling is enabled", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
      poll_interval_sec: "300",
    });
    const keys = issues.map((i) => i.key);
    expect(keys).toContain("wp_username");
    expect(keys).toContain("wp_application_password");
  });

  it("rejects a non-integer poll interval", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
      poll_interval_sec: "thirty",
    });
    expect(issues.map((i) => i.key)).toContain("poll_interval_sec");
  });

  it("accepts a zero poll interval (webhook-only mode)", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      webhook_shared_secret: "x",
      poll_interval_sec: "0",
    });
    expect(issues).toEqual([]);
  });
});

describe("WordpressConnector schema", () => {
  const connector = new WordpressConnector();
  const schema = connector.configSchema();
  const keys = schema.map((f) => f.key);

  it("declares all configuration fields the frontend will render", () => {
    expect(keys).toEqual([
      "site_url",
      "webhook_shared_secret",
      "wp_username",
      "wp_application_password",
      "post_types",
      "poll_interval_sec",
    ]);
  });

  it("declares the webhook secret as a Radioso-generated field, and the application password as a user secret", () => {
    const fieldsByKey = new Map(schema.map((field) => [field.key, field]));
    expect(fieldsByKey.get("webhook_shared_secret")?.type).toBe("generated_secret");
    expect(fieldsByKey.get("wp_application_password")?.type).toBe("secret");
  });

  it("uses site_url as the unique channel field so one site maps to one workspace", () => {
    expect(connector.uniqueChannelField()).toBe("site_url");
  });

  it("declares a workspace-scoped webhook path", () => {
    expect(connector.getWebhookPath()).toBe("/api/connectors/wordpress/:workspaceId/webhook");
  });
});

describe("WordpressConnector.onEnable", () => {
  const buildEnabledConnector = (overrides?: {
    config?: Record<string, string>;
    ensureSource?: ConnectorIngestionPort["ensureSource"];
    setErrorStatus?: ConnectorStatePort["setErrorStatus"];
    db?: ConnectorContext["db"];
  }) => {
    const connector = new WordpressConnector();
    const ensureSource = overrides?.ensureSource ?? vi.fn(async () => ({ id: "src-1" }));
    const setErrorStatus = overrides?.setErrorStatus ?? vi.fn(async () => {});
    const state: ConnectorStatePort = {
      getConfig: async () => ({ enabled: true, config: overrides?.config ?? { site_url: "https://example.com/" } }),
      setErrorStatus,
    };
    const ingestion = {
      ingest: vi.fn(async () => ({ documentId: "doc-1", status: "queued" })),
      deleteByExternalId: vi.fn(async () => false),
      ensureSource,
    } as unknown as ConnectorIngestionPort;
    const context: ConnectorContext = {
      db: overrides?.db ?? { query: async () => [] },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      chat: { answer: async () => ({ conversationId: "c-1", answer: "", outcome: "answered" }) },
      state,
      http: { mount: () => {} },
      ingestion,
    };
    return { connector, context, ensureSource, setErrorStatus };
  };

  it("registers a connector-kind source on enable using the configured site URL", async () => {
    const { connector, context, ensureSource } = buildEnabledConnector();
    await connector.initialize(context);
    await connector.onEnable!({ workspaceId: "ws-1" });

    expect(ensureSource).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: expect.objectContaining({
        externalId: "wordpress:https://example.com",
        name: "example.com",
      }),
    });
  });

  it("is a no-op when no site URL is configured yet", async () => {
    const { connector, context, ensureSource } = buildEnabledConnector({ config: {} });
    await connector.initialize(context);
    await connector.onEnable!({ workspaceId: "ws-1" });

    expect(ensureSource).not.toHaveBeenCalled();
  });

  it("swallows ensureSource failures so enable still succeeds", async () => {
    const ensureSource = vi.fn(async () => { throw new Error("boom"); });
    const { connector, context } = buildEnabledConnector({ ensureSource });
    await connector.initialize(context);

    await expect(connector.onEnable!({ workspaceId: "ws-1" })).resolves.toBeUndefined();
    expect(ensureSource).toHaveBeenCalled();
  });

  it("persists a sync failure status when backfill cannot read WordPress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const setErrorStatus = vi.fn(async () => {});
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING sync_lock_token")) {
        return [{ sync_lock_token: "lock-1" }];
      }
      return [];
    });
    const db: ConnectorContext["db"] = {
      query: query as ConnectorContext["db"]["query"],
    };
    const { connector, context } = buildEnabledConnector({ setErrorStatus, db });
    await connector.initialize(context);

    await expect(connector.backfillNow("ws-1")).rejects.toThrow("offline");

    expect(setErrorStatus).toHaveBeenCalledWith("ws-1", "sync_failed");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE connector_id = $1 AND workspace_id = $2 AND sync_lock_token = $3"),
      ["wordpress", "ws-1", "lock-1"],
    );
  });

  it("clears only sync-owned failure status after a successful backfill", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "x-wp-totalpages": "1" }),
      json: async () => [],
    })));
    const setErrorStatus = vi.fn(async () => {});
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING sync_lock_token")) {
        return [{ sync_lock_token: "lock-1" }];
      }
      return [];
    });
    const db: ConnectorContext["db"] = {
      query: query as ConnectorContext["db"]["query"],
    };
    const { connector, context } = buildEnabledConnector({ setErrorStatus, db });
    await connector.initialize(context);

    await expect(connector.backfillNow("ws-1")).resolves.toEqual({ ingested: 0 });

    expect(setErrorStatus).not.toHaveBeenCalledWith("ws-1", null);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE workspace_id = $1 AND connector_id = $2 AND error_status = $3"),
      ["ws-1", "wordpress", "sync_failed"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE connector_sync_state.sync_lock_token = $5"),
      ["wordpress", "ws-1", null, 0, "lock-1"],
    );
  });

  it("accepts manual sync by recording a durable backfill request", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING workspace_id")) {
        return [{ workspace_id: "ws-1" }];
      }
      return [];
    });
    const db: ConnectorContext["db"] = {
      query: query as ConnectorContext["db"]["query"],
    };
    const { connector, context } = buildEnabledConnector({ db });
    await connector.initialize(context);

    await expect(connector.syncNow!({ workspaceId: "ws-1" })).resolves.toEqual({
      accepted: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("sync_requested_at"),
      ["wordpress", "ws-1", expect.any(String)],
    );
  });

  it("reports an already-running manual sync without starting another backfill", async () => {
    const query = vi.fn(async () => []);
    const db: ConnectorContext["db"] = {
      query: query as ConnectorContext["db"]["query"],
    };
    const { connector, context } = buildEnabledConnector({ db });
    await connector.initialize(context);

    await expect(connector.syncNow!({ workspaceId: "ws-1" })).resolves.toEqual({
      accepted: false,
      alreadyRunning: true,
    });
  });
});
