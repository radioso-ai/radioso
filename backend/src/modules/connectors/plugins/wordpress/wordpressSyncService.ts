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
  ConnectorDatabasePort,
  ConnectorIngestionPort,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { WordpressClient } from "./wordpressClient.js";
import { mapRestPostToIngestInput } from "./wordpressIngest.js";
import { wordpressSourceFor } from "./wordpressSource.js";

const PER_PAGE = 100;
const TICK_INTERVAL_MS = 30_000;
const CONNECTOR_ID = "wordpress";

export interface WordpressSyncDeps {
  logger: ConnectorLogger;
  db: ConnectorDatabasePort;
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
  options?: { force?: boolean },
): Promise<{ ingested: number; skipped?: boolean }> => {
  const config = await deps.state.getConfig(workspaceId);
  if (!config?.enabled) return { ingested: 0 };

  if (!options?.force) {
    const [stateRow] = await deps.db.query<{ backfill_completed_at: string | null }>(
      `SELECT backfill_completed_at::text AS backfill_completed_at
         FROM connector_sync_state
        WHERE connector_id = $1 AND workspace_id = $2`,
      [CONNECTOR_ID, workspaceId],
    );
    if (stateRow?.backfill_completed_at) {
      return { ingested: 0, skipped: true };
    }
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

  await deps.db.query(
    `INSERT INTO connector_sync_state (connector_id, workspace_id, backfill_completed_at, last_run_at, last_modified_at)
     VALUES ($1, $2, NOW(), NOW(), $3)
     ON CONFLICT (connector_id, workspace_id) DO UPDATE
       SET backfill_completed_at = NOW(),
           last_run_at = NOW(),
           last_modified_at = COALESCE(EXCLUDED.last_modified_at, connector_sync_state.last_modified_at)`,
    [CONNECTOR_ID, workspaceId, highWaterMark],
  );

  deps.logger.info({ workspaceId, ingested }, "wordpress backfill completed");
  return { ingested };
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

  const [cursorRow] = await deps.db.query<{ last_modified_at: string | null }>(
    `SELECT last_modified_at::text AS last_modified_at
       FROM connector_sync_state
      WHERE connector_id = $1 AND workspace_id = $2`,
    [CONNECTOR_ID, workspaceId],
  );
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

  await deps.db.query(
    `INSERT INTO connector_sync_state (connector_id, workspace_id, last_run_at, last_modified_at)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (connector_id, workspace_id) DO UPDATE
       SET last_run_at = NOW(),
           last_modified_at = COALESCE(EXCLUDED.last_modified_at, connector_sync_state.last_modified_at)`,
    [CONNECTOR_ID, workspaceId, newCursor],
  );

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
  const due = await deps.db.query<{ workspace_id: string }>(
    `SELECT cc.workspace_id
       FROM connector_configs cc
       LEFT JOIN connector_sync_state s
         ON s.workspace_id = cc.workspace_id AND s.connector_id = cc.connector_id
      WHERE cc.connector_id = $1
        AND cc.enabled = true
        AND (cc.config_data->>'poll_interval_sec')::int > 0
        AND (
          s.last_run_at IS NULL
          OR s.last_run_at < NOW() - ((cc.config_data->>'poll_interval_sec')::int * INTERVAL '1 second')
        )`,
    [CONNECTOR_ID],
  );

  for (const row of due) {
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
