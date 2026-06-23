import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { ConnectorIngestionPort, ConnectorLogger, ConnectorStatePort } from "@radioso/connector-api";

import {
  claimBackfill,
  requestBackfill,
  runBackfill,
  type WordpressSyncDeps,
} from "../../src/modules/connectors/plugins/wordpress/wordpressSyncService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of the WordPress sync service's DB layer after the
// Kysely migration. Focuses on the conditional-upsert lock semantics that stayed raw
// (requestBackfill / claimBackfill against connector_sync_state) and the
// backfill-already-completed skip path. Behaviour here is the spec the rewrite preserves.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CONNECTOR_ID = "wordpress";

const silentLogger: ConnectorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeIntegration("wordpressSyncService (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  const stateConfig: { enabled: boolean; config: Record<string, string> } = {
    enabled: true,
    config: { site_url: "https://example.com", post_types: "post" },
  };
  const state: ConnectorStatePort = {
    getConfig: async () => stateConfig,
    setErrorStatus: async () => undefined,
  };
  const ingestion = {
    ingest: vi.fn(async () => ({ documentId: randomUUID(), status: "queued" })),
    deleteByExternalId: vi.fn(async () => true),
    ensureSource: vi.fn(async () => ({ id: randomUUID() })),
  } as unknown as ConnectorIngestionPort;

  const deps: WordpressSyncDeps = {
    logger: silentLogger,
    db: database.kysely,
    state,
    ingestion,
    // No HTTP: backfill is exercised via the skip path and the lock helpers directly.
    buildClient: () => {
      throw new Error("buildClient should not be called in these tests");
    },
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "WP Sync Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "WP WS", `route-${workspaceId.slice(0, 8)}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM connector_sync_state WHERE workspace_id = $1`, [workspaceId]).catch(
      () => undefined,
    );
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("requestBackfill inserts a request, then dedups while one is outstanding", async () => {
    const first = await requestBackfill(deps, workspaceId);
    expect(first).toEqual({ accepted: true });

    const second = await requestBackfill(deps, workspaceId);
    expect(second).toEqual({ accepted: false, alreadyRunning: true });

    const [row] = await database.query<{ sync_requested_at: string | null }>(
      `SELECT sync_requested_at FROM connector_sync_state WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );
    expect(row?.sync_requested_at).not.toBeNull();
  });

  it("claimBackfill acquires the lock once, then refuses while it is held", async () => {
    const token = await claimBackfill(deps, workspaceId);
    expect(token).not.toBeNull();

    const second = await claimBackfill(deps, workspaceId);
    expect(second).toBeNull();

    const [row] = await database.query<{ sync_lock_token: string | null; sync_requested_at: string | null }>(
      `SELECT sync_lock_token, sync_requested_at FROM connector_sync_state
         WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );
    expect(row?.sync_lock_token).toBe(token);
    // Claiming clears any outstanding request.
    expect(row?.sync_requested_at).toBeNull();
  });

  it("runBackfill skips when backfill_completed_at is already set and not forced", async () => {
    // Mark backfill complete and release the lock from the prior test.
    await database.query(
      `UPDATE connector_sync_state
          SET backfill_completed_at = NOW(), sync_started_at = NULL, sync_lock_token = NULL
        WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );

    const result = await runBackfill(deps, workspaceId);
    expect(result).toEqual({ ingested: 0, skipped: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it("runBackfill returns ingested:0 when the connector is disabled", async () => {
    stateConfig.enabled = false;
    try {
      const result = await runBackfill(deps, workspaceId);
      expect(result).toEqual({ ingested: 0 });
    } finally {
      stateConfig.enabled = true;
    }
  });
});
