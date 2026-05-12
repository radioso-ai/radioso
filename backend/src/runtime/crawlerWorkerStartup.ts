import type { Env } from "../app/config/env.js";
import type { AppLogger } from "../shared/observability/logger.js";

/**
 * Decides whether a crawler worker entrypoint should boot or exit cleanly.
 *
 * When `WEBSITE_CRAWLER_ENABLED=false` operators expect the container to come
 * up briefly, log why it is shutting itself off, and exit 0 so the orchestrator
 * removes it from the running set. Centralising the decision (and the log
 * message) keeps the two crawler entrypoints aligned and lets us cover the
 * branch with a unit test instead of having to spawn the entrypoint script.
 */
export const shouldRunCrawlerWorker = (
  env: Pick<Env, "WEBSITE_CRAWLER_ENABLED">,
  logger: Pick<AppLogger, "info">,
  role: "crawler-worker" | "crawler-worker-task",
): boolean => {
  if (env.WEBSITE_CRAWLER_ENABLED) {
    return true;
  }
  logger.info(
    { role },
    `WEBSITE_CRAWLER_ENABLED=false; ${role} is disabled. Exiting cleanly so the container can be removed.`,
  );
  return false;
};
