import type { Env } from "../config/env.js";
import { PostgresNotificationListener } from "../../shared/infra/postgresNotificationListener.js";
import type { AppLogger } from "../../shared/observability/logger.js";

/**
 * The process's one `LISTEN` connection, shared by everything that coordinates across instances
 * through Postgres notifications: chat turn supersession and voice session memory. It opens with the
 * first subscription and closes once nothing has subscribed for the pool's idle timeout.
 */
export const createPostgresNotificationListener = (input: {
  env: Pick<Env, "DATABASE_URL" | "NODE_ENV" | "DB_POOL_CONNECTION_TIMEOUT_MS" | "DB_POOL_IDLE_TIMEOUT_MS">;
  logger: AppLogger;
}): PostgresNotificationListener =>
  new PostgresNotificationListener({
    connectionString: input.env.DATABASE_URL,
    applicationName: `radioso-${input.env.NODE_ENV}-listener`,
    connectionTimeoutMs: input.env.DB_POOL_CONNECTION_TIMEOUT_MS,
    idleCloseMs: input.env.DB_POOL_IDLE_TIMEOUT_MS,
    logger: input.logger,
  });
