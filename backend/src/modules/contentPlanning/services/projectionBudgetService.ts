import type {
  ContentPlanProjectionBudgetPort,
  ContentPlanProjectionBudgetReservation,
  ContentPlanProjectionRepositoryPort,
} from "../contracts/persistence.js";

export interface ContentPlanProjectionBudgetPolicy {
  version: number;
  maxRequests: number;
  maxEstimatedSpendMicros: number;
}

/**
 * Conservative server-owned v1 ceiling per workspace and UTC day: 1,000 requests
 * and 5,000,000 spend micros ($5). It is injectable for tests/hosts, but is not
 * an operator setting in this feature.
 */
export const CONTENT_PLAN_PROJECTION_BUDGET_V1: ContentPlanProjectionBudgetPolicy = {
  version: 1,
  maxRequests: 1_000,
  maxEstimatedSpendMicros: 5_000_000,
};

export const CONTENT_PLAN_HISTORICAL_INTERPRETATION_ESTIMATED_SPEND_MICROS = 5_000;

export const utcBudgetWindowStart = (now: Date): Date => {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Projection budget requires a valid time");
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

export class ContentPlanProjectionBudgetService implements ContentPlanProjectionBudgetPort {
  constructor(
    private readonly projections: Pick<ContentPlanProjectionRepositoryPort, "reserveProjectionBudget">,
    private readonly policy: ContentPlanProjectionBudgetPolicy = CONTENT_PLAN_PROJECTION_BUDGET_V1,
  ) {
    for (const value of [policy.version, policy.maxRequests, policy.maxEstimatedSpendMicros]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Projection budget policy values must be positive safe integers");
      }
    }
  }

  reserve(input: {
    workspaceId: string;
    generationId: string;
    requests: number;
    estimatedSpendMicros: number;
    now: Date;
  }): Promise<ContentPlanProjectionBudgetReservation> {
    return this.projections.reserveProjectionBudget({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      budgetVersion: this.policy.version,
      budgetWindowStartedAt: utcBudgetWindowStart(input.now),
      requests: input.requests,
      estimatedSpendMicros: input.estimatedSpendMicros,
      maxRequests: this.policy.maxRequests,
      maxEstimatedSpendMicros: this.policy.maxEstimatedSpendMicros,
    });
  }

  refresh(input: {
    workspaceId: string;
    generationId: string;
    now: Date;
  }): Promise<ContentPlanProjectionBudgetReservation> {
    return this.reserve({
      ...input,
      requests: 0,
      estimatedSpendMicros: 0,
    });
  }
}
