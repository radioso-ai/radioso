import { z } from "zod";

import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { LlmCapabilityResolveInput } from "../../../../shared/infra/llm/workspaceContext.js";
import type { QueryRewritePort } from "../../domain/queryRewritePort.js";

export interface RewriteQueryToolDeps {
  readonly queryRewrite: QueryRewritePort;
  readonly workspaceContext?: LlmCapabilityResolveInput;
  readonly usageContext?: Omit<ModelCallUsageContext, "operation">;
}

const inputSchema = z.object({
  query: z.string().min(1, "query must not be empty"),
});

const outputSchema = z.object({
  semantic: z.string(),
  lexical: z.string(),
});

type RewriteQueryInput = z.infer<typeof inputSchema>;
type RewriteQueryOutput = z.infer<typeof outputSchema>;

export const createRewriteQueryTool = (
  deps: RewriteQueryToolDeps,
): AgentTool<RewriteQueryInput, RewriteQueryOutput> => ({
  name: "rewrite_query",
  description:
    "Reformulate a query into semantic and lexical forms. Useful when a literal search returns nothing — the model can also pass arbitrarily reformulated queries directly to semantic_search or lexical_search across steps.",
  inputSchema,
  outputSchema,
  async invoke(input, ctx) {
    return deps.queryRewrite.rewrite({
      query: input.query,
      workspaceContext: deps.workspaceContext,
      usageContext: deps.usageContext
        ? { ...deps.usageContext, attemptKey: `rewrite_tool:${ctx.stepIndex}:${ctx.callId}` }
        : undefined,
    });
  },
});
