/**
 * Backfill + polling sync for WordPress.
 *
 * Webhooks (companion plugin) are the primary delivery channel; this module
 * handles the two cases webhooks alone don't cover:
 *   - Initial backfill of every page/post that existed before the connector
 *     was enabled.
 *   - Polling fallback for sites that can't install the companion plugin.
 *
 * Both paths feed the same ConnectorIngestionPort.ingest().
 */

import type {
  ConnectorIngestionPort,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";

import { WordpressClient } from "./wordpressClient.js";
import { mapRestPostToIngestInput } from "./wordpressIngest.js";
import { wordpressSourceFor } from "./wordpressSource.js";

const PER_PAGE = 100;
const TICK_INTERVAL_MS = 30_000;
const CONNECTOR_ID = "wordpress";
const STALE_SYNC_LOCK_INTERVAL = "30 minutes";
const WORDPRESS_SYNC_FAILED_STATUS = "sync_failed";

export interface WordpressSyncDeps {
  logger: ConnectorLogger;
  db: Db;
  state: ConnectorStatePort;
  ingestion: ConnectorIngestionPort;
  /** Override for tests. Defaults to constructing a real client per workspace. */
  buildClient?: (config: Record<string, string>) => WordpressClient;
}

const defaultBuildClient = (config: Record<string, string>): WordpressClient =>
  new WordpressClient({
    siteUrl: config["site_url"] ?? "",
    username: config["wp_username"] || undefined,
    applicationPassword: config["wp_application_password"] || undefined,
  });

const postTypesFromConfig = (config: Record<string, string>): string[] =>
  (config["post_types"] ?? "page,post")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

/**
 * One-shot backfill of every published page/post for a workspace.
 *
 * Idempotent on re-run (same external ids upsert), but by default we skip when
 * `connector_sync_state.backfill_completed_at` is already set so a disable +
 * re-enable doesn't re-walk the whole site. Pass `{ force: true }` for an
 * explicit "Backfill now" admin action.
 */
export const runBackfill = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
  options?: { force?: boolean; lockToken?: string },
): Promise<{ ingested: number; skipped?: boolean; alreadyRunning?: boolean }> => {
  let lockToken = options?.lockToken ?? null;
  let completed = false;

  try {
    const config = await deps.state.getConfig(workspaceId);
    if (!config?.enabled) return { ingested: 0 };

    if (!options?.force) {
      const stateRow = await deps.db
        .selectFrom("connector_sync_state")
        // `::text` preserves Postgres' default timestamp text rendering, matching the
        // original raw SQL exactly (a custom to_char format would change the value).
        .select(sql<string | null>`backfill_completed_at::text`.as("backfill_completed_at"))
        .where("connector_id", "=", CONNECTOR_ID)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (stateRow?.backfill_completed_at) {
        return { ingested: 0, skipped: true };
      }
    }

    lockToken = lockToken ?? await claimBackfill(deps, workspaceId);
    if (!lockToken) {
      return { ingested: 0, alreadyRunning: true };
    }

    const client = (deps.buildClient ?? defaultBuildClient)(config.config);
    const types = postTypesFromConfig(config.config);
    const source = wordpressSourceFor(config.config);
    let ingested = 0;
    let highWaterMark: string | null = null;

    for (const type of types) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        await touchBackfillLock(deps, workspaceId, lockToken);
        const result = await client.fetchPostsPage({ type, page, perPage: PER_PAGE });
        totalPages = result.totalPages;
        for (const post of result.posts) {
          try {
            await deps.ingestion.ingest({
              ...mapRestPostToIngestInput(workspaceId, post),
              ...(source ? { source } : {}),
            });
            ingested += 1;
            if (!highWaterMark || post.modified_gmt > highWaterMark) {
              highWaterMark = post.modified_gmt;
            }
          } catch (error) {
            deps.logger.error(
              {
                workspaceId,
                type,
                postId: post.id,
                err: error instanceof Error ? error.message : String(error),
              },
              "wordpress backfill ingest failed",
            );
          }
        }
        page += 1;
      }
    }

    await completeBackfill(deps, workspaceId, lockToken, highWaterMark, ingested);
    completed = true;

    deps.logger.info({ workspaceId, ingested }, "wordpress backfill completed");
    return { ingested };
  } finally {
    if (lockToken && !completed) {
      await clearBackfillStarted(deps, workspaceId, lockToken);
    }
  }
};

export const runBackfillWithErrorStatus = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
  options?: { force?: boolean; lockToken?: string },
): Promise<{ ingested: number; skipped?: boolean; alreadyRunning?: boolean }> => {
  try {
    const result = await runBackfill(deps, workspaceId, options);
    if (!result.alreadyRunning) {
      await clearSyncFailedStatus(deps, workspaceId);
    }
    return result;
  } catch (error) {
    await deps.state.setErrorStatus(workspaceId, WORDPRESS_SYNC_FAILED_STATUS);
    throw error;
  }
};

const clearSyncFailedStatus = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
): Promise<void> => {
  await deps.db
    .updateTable("connector_configs")
    .set({ error_status: null, updated_at: currentTimestamp() })
    .where("workspace_id", "=", workspaceId)
    .where("connector_id", "=", CONNECTOR_ID)
    .where("error_status", "=", WORDPRESS_SYNC_FAILED_STATUS)
    .execute();
};

export const requestBackfill = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
): Promise<{ accepted: boolean; alreadyRunning?: boolean }> => {
  // Conditional upsert: only (re)request a backfill when none is already requested and
  // no recent run is in flight. The `DO UPDATE ... WHERE` predicate against the existing
  // row plus the `::interval` cast cannot be expressed by the query builder, so this is a
  // sanctioned raw fragment.
  const result = await sql<{ workspace_id: string }>`
    INSERT INTO connector_sync_state (connector_id, workspace_id, sync_requested_at)
    VALUES (${CONNECTOR_ID}, ${workspaceId}, NOW())
    ON CONFLICT (connector_id, workspace_id) DO UPDATE
      SET sync_requested_at = NOW()
      WHERE connector_sync_state.sync_requested_at IS NULL
        AND (
          connector_sync_state.sync_started_at IS NULL
          OR connector_sync_state.sync_started_at < NOW() - ${STALE_SYNC_LOCK_INTERVAL}::interval
        )
    RETURNING workspace_id
  `.execute(deps.db);
  return result.rows.length > 0 ? { accepted: true } : { accepted: false, alreadyRunning: true };
};

export const claimBackfill = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
): Promise<string | null> => {
  const lockToken = randomUUID();
  // Conditional lock acquisition: claim only when no live lock exists (stale-or-empty).
  // The dual `DO UPDATE ... WHERE` predicates + `::interval` cast keep this raw.
  const result = await sql<{ sync_lock_token: string }>`
    INSERT INTO connector_sync_state (
      connector_id,
      workspace_id,
      sync_started_at,
      sync_lock_token,
      last_run_at
    )
    VALUES (${CONNECTOR_ID}, ${workspaceId}, NOW(), ${lockToken}, NOW())
    ON CONFLICT (connector_id, workspace_id) DO UPDATE
      SET sync_requested_at = NULL,
          sync_started_at = NOW(),
          sync_lock_token = ${lockToken},
          last_run_at = NOW()
      WHERE (
          connector_sync_state.sync_requested_at IS NOT NULL
          OR connector_sync_state.sync_started_at IS NULL
          OR connector_sync_state.sync_started_at < NOW() - ${STALE_SYNC_LOCK_INTERVAL}::interval
        )
        AND (
          connector_sync_state.sync_started_at IS NULL
          OR connector_sync_state.sync_started_at < NOW() - ${STALE_SYNC_LOCK_INTERVAL}::interval
        )
    RETURNING sync_lock_token
  `.execute(deps.db);
  return result.rows[0]?.sync_lock_token ?? null;
};

const touchBackfillLock = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
  lockToken: string,
): Promise<void> => {
  await deps.db
    .updateTable("connector_sync_state")
    .set({ sync_started_at: currentTimestamp() })
    .where("connector_id", "=", CONNECTOR_ID)
    .where("workspace_id", "=", workspaceId)
    .where("sync_lock_token", "=", lockToken)
    .execute();
};

const completeBackfill = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
  lockToken: string,
  highWaterMark: string | null,
  ingested: number,
): Promise<void> => {
  // Lock-guarded completion upsert: the `DO UPDATE ... WHERE sync_lock_token = $5`
  // predicate (only the holder of this lock may complete) and the
  // `COALESCE(EXCLUDED.last_modified_at, existing)` advance keep this raw.
  await sql`
    INSERT INTO connector_sync_state (
      connector_id,
      workspace_id,
      backfill_completed_at,
      sync_requested_at,
      sync_started_at,
      sync_lock_token,
      last_run_at,
      last_modified_at,
      last_ingested_count
    )
    VALUES (${CONNECTOR_ID}, ${workspaceId}, NOW(), NULL, NULL, NULL, NOW(), ${highWaterMark}, ${ingested})
    ON CONFLICT (connector_id, workspace_id) DO UPDATE
      SET backfill_completed_at = NOW(),
          sync_requested_at = NULL,
          sync_started_at = NULL,
          sync_lock_token = NULL,
          last_run_at = NOW(),
          last_modified_at = COALESCE(EXCLUDED.last_modified_at, connector_sync_state.last_modified_at),
          last_ingested_count = EXCLUDED.last_ingested_count
      WHERE connector_sync_state.sync_lock_token = ${lockToken}
  `.execute(deps.db);
};

const clearBackfillStarted = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
  lockToken: string,
): Promise<void> => {
  await deps.db
    .updateTable("connector_sync_state")
    .set({ sync_started_at: null, sync_lock_token: null })
    .where("connector_id", "=", CONNECTOR_ID)
    .where("workspace_id", "=", workspaceId)
    .where("sync_lock_token", "=", lockToken)
    .execute();
};

/**
 * Per-workspace incremental poll. Fetches posts modified strictly after the
 * stored cursor for each post type, ingests, then advances the cursor.
 */
export const runPoll = async (
  deps: WordpressSyncDeps,
  workspaceId: string,
): Promise<{ ingested: number }> => {
  const config = await deps.state.getConfig(workspaceId);
  if (!config?.enabled) return { ingested: 0 };

  const cursorRow = await deps.db
    .selectFrom("connector_sync_state")
    .select(sql<string | null>`last_modified_at::text`.as("last_modified_at"))
    .where("connector_id", "=", CONNECTOR_ID)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  const cursor = cursorRow?.last_modified_at ?? null;

  const client = (deps.buildClient ?? defaultBuildClient)(config.config);
  const types = postTypesFromConfig(config.config);
  const source = wordpressSourceFor(config.config);
  let ingested = 0;
  let newCursor = cursor;

  for (const type of types) {
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const result = await client.fetchPostsPage({
        type,
        page,
        perPage: PER_PAGE,
        modifiedAfter: cursor ?? undefined,
      });
      totalPages = result.totalPages;
      for (const post of result.posts) {
        try {
          await deps.ingestion.ingest({
            ...mapRestPostToIngestInput(workspaceId, post),
            ...(source ? { source } : {}),
          });
          ingested += 1;
          if (!newCursor || post.modified_gmt > newCursor) {
            newCursor = post.modified_gmt;
          }
        } catch (error) {
          deps.logger.error(
            {
              workspaceId,
              type,
              postId: post.id,
              err: error instanceof Error ? error.message : String(error),
            },
            "wordpress poll ingest failed",
          );
        }
      }
      page += 1;
    }
  }

  // Cursor advance upsert: `COALESCE(EXCLUDED.last_modified_at, existing)` keeps a poll
  // that ingested nothing from clobbering the stored high-water mark; raw fragment.
  await sql`
    INSERT INTO connector_sync_state (connector_id, workspace_id, last_run_at, last_modified_at, last_ingested_count)
    VALUES (${CONNECTOR_ID}, ${workspaceId}, NOW(), ${newCursor}, ${ingested})
    ON CONFLICT (connector_id, workspace_id) DO UPDATE
      SET last_run_at = NOW(),
          last_modified_at = COALESCE(EXCLUDED.last_modified_at, connector_sync_state.last_modified_at),
          last_ingested_count = EXCLUDED.last_ingested_count
  `.execute(deps.db);

  if (ingested > 0) {
    deps.logger.info({ workspaceId, ingested }, "wordpress poll ingested updates");
  }
  return { ingested };
};

// ── Background loop ─────────────────────────────────────────────────────────

let tickHandle: NodeJS.Timeout | null = null;

export const startPollingLoop = (deps: WordpressSyncDeps): void => {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    void tick(deps).catch((error) =>
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "wordpress poll tick failed",
      ),
    );
  }, TICK_INTERVAL_MS);
  // Don't keep the process alive solely for this timer.
  tickHandle.unref?.();
};

export const stopPollingLoop = (): void => {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
};

const tick = async (deps: WordpressSyncDeps): Promise<void> => {
  // Workspaces with an explicit sync request or a stale in-flight lock. The
  // `::interval` cast on the staleness predicate keeps this raw.
  const requested = await sql<{ workspace_id: string }>`
    SELECT cc.workspace_id
      FROM connector_configs cc
      JOIN connector_sync_state s
        ON s.workspace_id = cc.workspace_id AND s.connector_id = cc.connector_id
     WHERE cc.connector_id = ${CONNECTOR_ID}
       AND cc.enabled = true
       AND (
         s.sync_requested_at IS NOT NULL
         OR s.sync_started_at < NOW() - ${STALE_SYNC_LOCK_INTERVAL}::interval
       )
  `.execute(deps.db);

  for (const row of requested.rows) {
    try {
      const lockToken = await claimBackfill(deps, row.workspace_id);
      if (lockToken) {
        await runBackfillWithErrorStatus(deps, row.workspace_id, { force: true, lockToken });
      }
    } catch (error) {
      deps.logger.error(
        {
          workspaceId: row.workspace_id,
          err: error instanceof Error ? error.message : String(error),
        },
        "wordpress requested backfill failed",
      );
    }
  }

  // Workspaces due for a poll: `(config_data->>'poll_interval_sec')::int` arithmetic and
  // the dynamic `INTERVAL '1 second'` multiplication keep this raw.
  const due = await sql<{ workspace_id: string }>`
    SELECT cc.workspace_id
      FROM connector_configs cc
      LEFT JOIN connector_sync_state s
        ON s.workspace_id = cc.workspace_id AND s.connector_id = cc.connector_id
     WHERE cc.connector_id = ${CONNECTOR_ID}
       AND cc.enabled = true
       AND (cc.config_data->>'poll_interval_sec')::int > 0
       AND (
         s.last_run_at IS NULL
         OR s.last_run_at < NOW() - ((cc.config_data->>'poll_interval_sec')::int * INTERVAL '1 second')
       )
  `.execute(deps.db);

  for (const row of due.rows) {
    try {
      await runPoll(deps, row.workspace_id);
    } catch (error) {
      deps.logger.error(
        {
          workspaceId: row.workspace_id,
          err: error instanceof Error ? error.message : String(error),
        },
        "wordpress poll workspace failed",
      );
    }
  }
};
