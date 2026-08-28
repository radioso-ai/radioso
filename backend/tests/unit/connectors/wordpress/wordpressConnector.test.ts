import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorContext,
  ConnectorIngestionPort,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { WordpressConnector } from "../../../../src/modules/connectors/plugins/wordpress/wordpressConnector.js";
import { wordpressSyncErrorMessage } from "../../../../src/modules/connectors/plugins/wordpress/wordpressSyncService.js";

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
  // These cases exercise onEnable's source-registration orchestration only; they never reach
  // the connector's DB layer, so a no-op `query` stub for `context.db` is sufficient. The
  // backfill/sync cases that DID hit the DB moved to a real-Postgres integration suite
  // (tests/integration/connectors/wordpress-connector.integration.test.ts) after the Kysely
  // migration, since the connector now derives Kysely from `context.db.kysely`.
  const buildEnabledConnector = (overrides?: {
    config?: Record<string, string>;
    ensureSource?: ConnectorIngestionPort["ensureSource"];
    setErrorStatus?: ConnectorStatePort["setErrorStatus"];
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
      db: { query: async () => [] } as unknown as ConnectorContext["db"],
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      chat: { answer: async () => ({ conversationId: "c-1", answer: "", outcome: "answered" }) },
      state,
      http: { mount: () => {} },
      ingestion,
      publicHttp: {
        assertPublicUrl: async () => undefined,
        fetch: (input, init) => fetch(input, init),
      },
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
});

describe("wordpressSyncErrorMessage", () => {
  it("keeps actionable HTTP status and strips credentials and query parameters", () => {
    const message = wordpressSyncErrorMessage(
      new Error("WordPress REST returned 401 Unauthorized for https://alice:secret@example.com/wp-json/wp/v2/posts?page=1"),
    );

    expect(message).toBe("WordPress REST returned 401 Unauthorized for https://example.com/wp-json/wp/v2/posts");
    expect(message).not.toContain("alice");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("page=1");
  });

  it("keeps a bounded network diagnostic without exposing unexpected internal errors", () => {
    expect(wordpressSyncErrorMessage(new Error("offline"))).toBe(
      "Unable to reach the WordPress REST API (offline).",
    );
    expect(wordpressSyncErrorMessage(new Error("relation connector_sync_state does not exist"))).toBe(
      "WordPress sync failed due to an internal error. Check the server logs for the matching workspace and sync time.",
    );
  });
});
