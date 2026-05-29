import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

export interface QueryRewritePortRequest {
  readonly query: string;
  readonly workspaceContext?: LlmCapabilityResolveInput;
  readonly usageContext?: Omit<ModelCallUsageContext, "operation">;
}

export interface QueryRewritePortResult {
  readonly semantic: string;
  readonly lexical: string;
}

/**
 * Narrow rewrite port for callers that want a model-produced
 * `{ semantic, lexical }` reformulation of a query without inheriting the
 * deterministic pipeline's eligibility checks, intent routing, subquery
 * planning, or rewrite-policy guardrails. Implementations MUST return the
 * original query as both forms when no usable rewrite is available, so that
 * callers can rely on a non-empty result.
 */
export interface QueryRewritePort {
  rewrite(input: QueryRewritePortRequest): Promise<QueryRewritePortResult>;
}
