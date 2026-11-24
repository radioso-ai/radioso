import type { WebsiteRecrawlRepositoryPort } from "../../db/repositories/websiteRecrawlRepository.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { classifyWebsiteCrawlerFailure } from "./errors.js";
import {
  effectiveRecrawlCadence,
  nextRecrawlAfterRun,
  recrawlJitterMs,
  type ActiveRecrawlCadence,
  type CrawlTrigger,
  type RecrawlPlanPort,
} from "./recrawlSchedule.js";

/** Rows one claim takes, and the most claims one run makes; a backlog drains over the next runs. */
const WEBSITE_RECRAWL_BATCH_SIZE = 50;
const WEBSITE_RECRAWL_MAX_BATCHES_PER_RUN = 10;
/** The cadence a source runs at when its workspace's plan cannot be read: no plan allows less. */
const UNREAD_PLAN_RECRAWL_CADENCE: ActiveRecrawlCadence = "monthly";

/** Queues a source's stored crawl. The documents module's recrawl, which reads the source's saved scope. */
export interface ScheduledRecrawlPort {
  recrawlSource(input: { accountId: null; workspaceId: string; sourceId: string; trigger: CrawlTrigger }): Promise<unknown>;
}

interface WebsiteRecrawlSweepCounts {
  due: number;
  enqueued: number;
  /** Due sources that already had a crawl queued or running; they wait for their next time. */
  skippedActive: number;
  failed: number;
}

/**
 * Queues a crawl for every website source whose recrawl is due. Each claim moves the source's next
 * recrawl one interval ahead first, at its cadence slowed to the plan's fastest, so a source that
 * fails to queue is tried again at its next time rather than on every run.
 */
export class WebsiteRecrawlSweep {
  constructor(private readonly dependencies: {
    schedule: Pick<WebsiteRecrawlRepositoryPort, "claimDueRecrawls">;
    plan: RecrawlPlanPort;
    recrawls: ScheduledRecrawlPort;
    logger: Pick<AppLogger, "info" | "warn">;
    clock?: () => Date;
    random?: () => number;
    batchSize?: number;
    maxBatchesPerRun?: number;
  }) {}

  async run(): Promise<WebsiteRecrawlSweepCounts> {
    const now = (this.dependencies.clock ?? (() => new Date()))();
    const batchSize = this.dependencies.batchSize ?? WEBSITE_RECRAWL_BATCH_SIZE;
    const maxBatches = this.dependencies.maxBatchesPerRun ?? WEBSITE_RECRAWL_MAX_BATCHES_PER_RUN;
    const fastestByWorkspace = new Map<string, Promise<ActiveRecrawlCadence>>();
    // Read inside the claim's transaction, so a plan that cannot be read must not throw: that would
    // roll back the whole batch, and the same source would lead the next sweep's batch too.
    const fastestFor = (workspaceId: string): Promise<ActiveRecrawlCadence> => {
      const known = fastestByWorkspace.get(workspaceId);
      if (known) return known;
      const read = this.dependencies.plan.fastestRecrawlCadence({ workspaceId }).catch(() => {
        // The workspace only: a lookup's message can name billing identifiers.
        this.dependencies.logger.warn(
          { role: "website-recrawl-sweep", workspaceId },
          "Website recrawl plan could not be read; the workspace's sources recrawl monthly this time",
        );
        return UNREAD_PLAN_RECRAWL_CADENCE;
      });
      fastestByWorkspace.set(workspaceId, read);
      return read;
    };
    const counts: WebsiteRecrawlSweepCounts = { due: 0, enqueued: 0, skippedActive: 0, failed: 0 };

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const claimed = await this.dependencies.schedule.claimDueRecrawls({
        now,
        limit: batchSize,
        nextRecrawlAt: async (source) => nextRecrawlAfterRun({
          now,
          cadence: effectiveRecrawlCadence(source.recrawlCadence, await fastestFor(source.workspaceId)),
          jitterMs: recrawlJitterMs(this.dependencies.random),
        }),
      });
      counts.due += claimed.length;
      for (const source of claimed) {
        if (source.crawlActive) {
          counts.skippedActive += 1;
          continue;
        }
        try {
          await this.dependencies.recrawls.recrawlSource({
            accountId: null,
            workspaceId: source.workspaceId,
            sourceId: source.sourceId,
            trigger: "scheduled",
          });
          counts.enqueued += 1;
        } catch (error) {
          counts.failed += 1;
          this.dependencies.logger.warn(
            // The failure's code, not its message: a message can quote the site's address.
            { role: "website-recrawl-sweep", workspaceId: source.workspaceId, sourceId: source.sourceId, failureCode: classifyWebsiteCrawlerFailure(error).code },
            "Website recrawl could not be queued; the source is tried again at its next recrawl",
          );
        }
      }
      if (claimed.length < batchSize) break;
    }

    this.dependencies.logger.info({ role: "website-recrawl-sweep", ...counts }, "Website recrawl sweep finished");
    return counts;
  }
}
