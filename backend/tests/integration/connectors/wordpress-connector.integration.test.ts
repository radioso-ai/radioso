import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import type {
  ConnectorContext,
  ConnectorIngestionPort,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { WordpressConnector } from "../../../src/modules/connectors/plugins/wordpress/wordpressConnector.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres characterization of the WordpressConnector's enable/sync orchestration.
//
// These cases used to inject a `{ query }` raw-SQL mock as `context.db`, but after the
// Kysely migration the connector derives its DB via `connectorKyselyDb(context.db)`
// (which reads `context.db.kysely`) and the sync service issues Kysely SQL. So we back
// `context.db` with a real `Database` — exposing both the published `query()` port and the
// `.kysely` handle the bridge needs — and seed `connector_configs` / `connector_sync_state`
// rows so the backfill/sync paths hit real SQL. The orchestration assertions (setErrorStatus
// on failure, sync-owned status clearing on success, durable request recording, and
// already-running detection) are preserved exactly.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CONNECTOR_ID = "wordpress";
const SITE_URL = "https://example.com/";

describeIntegration("WordpressConnector orchestration (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);

  const accountId = randomUUID();

  // `context.db` carries both the published query-only port AND the `.kysely` handle the
  // connectorKyselyDb bridge reads — mirroring the real runtime injection of the full Database.
  const connectorDb = {
    query: database.query.bind(database),
    kysely: database.kysely,
  } as unknown as ConnectorContext["db"];

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "WP Connector Co", `acct-${accountId}@example.com`, "hash"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const seedWorkspace = async (workspaceId: string) => {
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "WP WS", `route-${workspaceId.slice(0, 8)}`],
    );
  };

  const seedConnectorConfig = async (
    workspaceId: string,
    options: { errorStatus?: string | null } = {},
  ) => {
    await database.query(
      `INSERT INTO connector_configs (workspace_id, connector_id, enabled, config_data, error_status)
       VALUES ($1, $2, true, $3::jsonb, $4)`,
      [workspaceId, CONNECTOR_ID, JSON.stringify({ site_url: SITE_URL }), options.errorStatus ?? null],
    );
  };

  type Built = {
    connector: WordpressConnector;
    setErrorStatus: ReturnType<typeof vi.fn>;
    ensureSource: ReturnType<typeof vi.fn>;
  };

  // Builds an initialized connector wired to the real DB. State/ingestion/logger/http/chat
  // stay as spies/fakes so the orchestration assertions (setErrorStatus, ensureSource) hold.
  const buildConnector = async (workspaceId: string): Promise<Built> => {
    const setErrorStatus = vi.fn(async () => {});
    const ensureSource = vi.fn(async () => ({ id: "src-1" }));
    const state: ConnectorStatePort = {
      getConfig: async () => ({ enabled: true, config: { site_url: SITE_URL } }),
      setErrorStatus,
    };
    const ingestion = {
      ingest: vi.fn(async () => ({ documentId: "doc-1", status: "queued" })),
      deleteByExternalId: vi.fn(async () => false),
      ensureSource,
    } as unknown as ConnectorIngestionPort;
    const context: ConnectorContext = {
      db: connectorDb,
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
    const connector = new WordpressConnector();
    await connector.initialize(context);
    return { connector, setErrorStatus, ensureSource };
  };

  let connector: WordpressConnector | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Clear the module-level polling interval started by initialize().
    await connector?.shutdown();
    connector = null;
  });

  it("persists a sync failure status when backfill cannot read WordPress", async () => {
    const workspaceId = randomUUID();
    await seedWorkspace(workspaceId);
    await seedConnectorConfig(workspaceId);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const built = await buildConnector(workspaceId);
    connector = built.connector;

    await expect(built.connector.backfillNow(workspaceId)).rejects.toThrow("offline");

    // The source must exist even when WordPress fails before returning its first post.
    // This keeps failed connectors visible and inspectable in Knowledge → Sources.
    expect(built.ensureSource).toHaveBeenCalledWith({
      workspaceId,
      source: expect.objectContaining({
        externalId: "wordpress:https://example.com",
        name: "example.com",
      }),
    });

    // Connector orchestration: the failure is recorded as a durable sync_failed status.
    expect(built.setErrorStatus).toHaveBeenCalledWith(workspaceId, "sync_failed");

    // And the claimed lock was released by the runBackfill finally block.
    const [row] = await database.query<{
      sync_lock_token: string | null;
      sync_started_at: string | null;
      last_error: string | null;
    }>(
      `SELECT sync_lock_token, sync_started_at, last_error FROM connector_sync_state
         WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );
    expect(row?.sync_lock_token).toBeNull();
    expect(row?.sync_started_at).toBeNull();
    expect(row?.last_error).toBe("Unable to reach the WordPress REST API (offline).");
  });

  it("clears only sync-owned failure status after a successful backfill", async () => {
    const workspaceId = randomUUID();
    await seedWorkspace(workspaceId);
    // Pre-seed a sync_failed status: a successful backfill must clear exactly this one.
    await seedConnectorConfig(workspaceId, { errorStatus: "sync_failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-wp-totalpages": "1" }),
        json: async () => [],
      })),
    );

    const built = await buildConnector(workspaceId);
    connector = built.connector;

    await expect(built.connector.backfillNow(workspaceId)).resolves.toEqual({ ingested: 0 });

    // Connector orchestration: never overwrites a user-owned status via setErrorStatus(null);
    // the sync-owned status is cleared by the connector's own scoped UPDATE.
    expect(built.setErrorStatus).not.toHaveBeenCalledWith(workspaceId, null);

    const [row] = await database.query<{
      error_status: string | null;
      backfill_completed_at: string | null;
      last_error: string | null;
    }>(
      `SELECT cc.error_status, s.backfill_completed_at, s.last_error
         FROM connector_configs cc
         JOIN connector_sync_state s
           ON s.workspace_id = cc.workspace_id AND s.connector_id = cc.connector_id
        WHERE cc.workspace_id = $1 AND cc.connector_id = $2`,
      [workspaceId, CONNECTOR_ID],
    );
    expect(row?.error_status).toBeNull();
    expect(row?.backfill_completed_at).not.toBeNull();
    expect(row?.last_error).toBeNull();
  });

  it("only clears the failure status when it is sync-owned", async () => {
    const workspaceId = randomUUID();
    await seedWorkspace(workspaceId);
    // A status the connector does not own must survive a successful backfill.
    await seedConnectorConfig(workspaceId, { errorStatus: "auth_failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-wp-totalpages": "1" }),
        json: async () => [],
      })),
    );

    const built = await buildConnector(workspaceId);
    connector = built.connector;

    await expect(built.connector.backfillNow(workspaceId)).resolves.toEqual({ ingested: 0 });

    const [row] = await database.query<{ error_status: string | null }>(
      `SELECT error_status FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, CONNECTOR_ID],
    );
    expect(row?.error_status).toBe("auth_failed");
  });

  it("accepts manual sync by recording a durable backfill request", async () => {
    const workspaceId = randomUUID();
    await seedWorkspace(workspaceId);
    await seedConnectorConfig(workspaceId);

    const built = await buildConnector(workspaceId);
    connector = built.connector;

    await expect(built.connector.syncNow!({ workspaceId })).resolves.toEqual({ accepted: true });
    expect(built.ensureSource).toHaveBeenCalledWith({
      workspaceId,
      source: expect.objectContaining({
        externalId: "wordpress:https://example.com",
      }),
    });

    const [row] = await database.query<{ sync_requested_at: string | null }>(
      `SELECT sync_requested_at FROM connector_sync_state
         WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );
    expect(row?.sync_requested_at).not.toBeNull();
  });

  it("reports an already-running manual sync without starting another backfill", async () => {
    const workspaceId = randomUUID();
    await seedWorkspace(workspaceId);
    await seedConnectorConfig(workspaceId);
    // A request is already outstanding: the conditional upsert must dedup it.
    await database.query(
      `INSERT INTO connector_sync_state (connector_id, workspace_id, sync_requested_at)
       VALUES ($1, $2, NOW())`,
      [CONNECTOR_ID, workspaceId],
    );

    const built = await buildConnector(workspaceId);
    connector = built.connector;

    await expect(built.connector.syncNow!({ workspaceId })).resolves.toEqual({
      accepted: false,
      alreadyRunning: true,
    });
  });
});
