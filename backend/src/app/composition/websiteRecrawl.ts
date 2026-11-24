import type { DocumentSourceRepositoryPort } from "../../db/repositories/documentSourceRepository.js";
import type { WebsiteRecrawlRepositoryPort } from "../../db/repositories/websiteRecrawlRepository.js";
import { WebsiteHeldPagesService, type WebsiteSourcePageRemovalPort } from "../../modules/websiteCrawler/heldPagesService.js";
import type { WebsiteHeldPageStore } from "../../modules/websiteCrawler/missingPages.js";
import type { RecrawlPlanPort } from "../../modules/websiteCrawler/recrawlSchedule.js";
import { WebsiteRecrawlScheduleService } from "../../modules/websiteCrawler/recrawlScheduleService.js";
import { WebsiteRecrawlSweep, type ScheduledRecrawlPort } from "../../modules/websiteCrawler/recrawlSweep.js";
import type { WebsiteCrawlerAuditPort } from "../../modules/websiteCrawler/service.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { ApplicationPeriodicTaskHandle } from "./applicationModule.js";

/** The registration id the worker task route runs it by, and the Cloud Scheduler job's name. */
const WEBSITE_RECRAWL_TASK_ID = "website-recrawl";
/** Every 15 minutes, matching `website_recrawl_schedule` in Terraform. A source is queued at most this late. */
const WEBSITE_RECRAWL_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * The plan's recrawl ceiling, read through the usage limit policy that already knows a workspace's
 * plan. A policy without plans (self-hosted, the OSS default) sets none, so `daily` is allowed.
 */
export const recrawlPlanFromUsageLimits = (
  usageLimits: Pick<UsageLimitPolicy, "getFastestRecrawlCadence">,
): RecrawlPlanPort => ({
  fastestRecrawlCadence: async ({ workspaceId }) =>
    (await usageLimits.getFastestRecrawlCadence?.({ workspaceId })) ?? "daily",
});

export const websiteRecrawlPeriodicTask = (
  sweep: Pick<WebsiteRecrawlSweep, "run">,
): { id: string; intervalMs: number; handle: ApplicationPeriodicTaskHandle } => ({
  id: WEBSITE_RECRAWL_TASK_ID,
  intervalMs: WEBSITE_RECRAWL_INTERVAL_MS,
  handle: {
    run: async () => {
      await sweep.run();
    },
  },
});

/** Scheduled recrawl: the cadence setting, the operator's decision on held pages, and the sweep. */
export const createWebsiteRecrawlComposition = (deps: {
  schedule: WebsiteRecrawlRepositoryPort;
  missingPages: WebsiteHeldPageStore;
  sources: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">;
  usageLimits: Pick<UsageLimitPolicy, "getFastestRecrawlCadence">;
  recrawls: ScheduledRecrawlPort;
  pages: WebsiteSourcePageRemovalPort;
  audit: WebsiteCrawlerAuditPort;
  logger: Pick<AppLogger, "info" | "warn">;
}) => {
  const plan = recrawlPlanFromUsageLimits(deps.usageLimits);
  return {
    scheduleService: new WebsiteRecrawlScheduleService({ sources: deps.sources, schedule: deps.schedule, heldPages: deps.missingPages, plan }),
    heldPagesService: new WebsiteHeldPagesService({ sources: deps.sources, heldPages: deps.missingPages, pages: deps.pages, audit: deps.audit }),
    periodicTask: websiteRecrawlPeriodicTask(new WebsiteRecrawlSweep({ schedule: deps.schedule, plan, recrawls: deps.recrawls, logger: deps.logger })),
  };
};

export type WebsiteRecrawlComposition = ReturnType<typeof createWebsiteRecrawlComposition>;
