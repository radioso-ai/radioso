import type { DocumentSourceRecord, DocumentSourceRepositoryPort } from "../../db/repositories/documentSourceRepository.js";
import type { WebsiteRecrawlRepositoryPort } from "../../db/repositories/websiteRecrawlRepository.js";
import { AppError, badRequest, notFound } from "../../shared/domain/errors.js";
import type { WebsiteHeldPageStore } from "./missingPages.js";
import {
  effectiveRecrawlCadence,
  firstRecrawlAt,
  isRecrawlCadenceWithinPlan,
  recrawlJitterMs,
  type ActiveRecrawlCadence,
  type RecrawlCadence,
  type RecrawlPlanPort,
} from "./recrawlSchedule.js";

export const RECRAWL_CADENCE_NOT_IN_PLAN_CODE = "recrawl_cadence_not_in_plan";

const recrawlCadenceNotInPlan = (fastestRecrawlCadence: ActiveRecrawlCadence): AppError =>
  new AppError(403, RECRAWL_CADENCE_NOT_IN_PLAN_CODE, `This plan recrawls a website ${fastestRecrawlCadence} at most`, {
    fastestRecrawlCadence,
  });

/** Loads one of the workspace's website sources, or refuses the request. */
export const requireWebsiteSource = async (
  sources: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">,
  input: { workspaceId: string; sourceId: string },
): Promise<DocumentSourceRecord> => {
  const source = await sources.findByIdAndWorkspaceId(input.sourceId, input.workspaceId);
  if (!source) {
    throw notFound("Source not found");
  }
  if (source.kind !== "website") {
    throw badRequest("Only website sources recrawl");
  }
  return source;
};

export interface WebsiteRecrawlDescription {
  fastestRecrawlCadence: ActiveRecrawlCadence;
  heldPageCounts: Map<string, number>;
}

/** The operator's recrawl cadence for a website source, held to the plan's fastest. */
export class WebsiteRecrawlScheduleService {
  constructor(private readonly dependencies: {
    sources: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">;
    schedule: Pick<WebsiteRecrawlRepositoryPort, "setRecrawlSchedule">;
    heldPages: Pick<WebsiteHeldPageStore, "countHeldPages">;
    plan: RecrawlPlanPort;
    clock?: () => Date;
    random?: () => number;
  }) {}

  /**
   * Turning a cadence on or changing it schedules the first recrawl one interval after the last
   * sync (never before now), at the cadence the plan lets it run. Choosing the stored cadence again
   * keeps the time already scheduled.
   */
  async setRecrawlCadence(input: { workspaceId: string; sourceId: string; recrawlCadence: RecrawlCadence }): Promise<DocumentSourceRecord> {
    const source = await requireWebsiteSource(this.dependencies.sources, input);
    const fastest = await this.dependencies.plan.fastestRecrawlCadence({ workspaceId: input.workspaceId });
    if (!isRecrawlCadenceWithinPlan(input.recrawlCadence, fastest)) {
      throw recrawlCadenceNotInPlan(fastest);
    }
    if (source.recrawlCadence === input.recrawlCadence) {
      return source;
    }
    const updated = await this.dependencies.schedule.setRecrawlSchedule({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      recrawlCadence: input.recrawlCadence,
      nextRecrawlAt: firstRecrawlAt({
        now: (this.dependencies.clock ?? (() => new Date()))(),
        lastSyncedAt: source.lastSyncedAt,
        cadence: effectiveRecrawlCadence(input.recrawlCadence, fastest),
        jitterMs: recrawlJitterMs(this.dependencies.random),
      }),
    });
    if (!updated) {
      throw notFound("Source not found");
    }
    return updated;
  }

  async describeRecrawl(input: { workspaceId: string; sourceIds: readonly string[] }): Promise<WebsiteRecrawlDescription> {
    const [fastestRecrawlCadence, heldPageCounts] = await Promise.all([
      this.dependencies.plan.fastestRecrawlCadence({ workspaceId: input.workspaceId }),
      this.dependencies.heldPages.countHeldPages(input),
    ]);
    return { fastestRecrawlCadence, heldPageCounts };
  }
}
