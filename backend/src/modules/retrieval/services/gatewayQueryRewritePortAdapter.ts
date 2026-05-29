import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type {
  QueryRewritePort,
  QueryRewritePortRequest,
  QueryRewritePortResult,
} from "../domain/queryRewritePort.js";
import type {
  QueryRewriteGateway,
  QueryRewriteGatewayResult,
} from "./queryRewriteGateways.js";

const trimOrFallback = (candidate: string | undefined, fallback: string): string => {
  const trimmed = (candidate ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const pickSemantic = (result: QueryRewriteGatewayResult, originalQuery: string): string => {
  const fromGateway = trimOrFallback(result.semanticQuery, "") || trimOrFallback(result.rewrittenQuery, "");
  return fromGateway.length > 0 ? fromGateway : originalQuery;
};

const pickLexical = (result: QueryRewriteGatewayResult, originalQuery: string): string => {
  const fromGateway = trimOrFallback(result.lexicalQuery, "") || trimOrFallback(result.rewrittenQuery, "");
  return fromGateway.length > 0 ? fromGateway : originalQuery;
};

const resolveUsageContext = (input: QueryRewritePortRequest): Omit<ModelCallUsageContext, "operation"> =>
  input.usageContext ?? {
    workspaceId: input.workspaceContext?.workspaceId ?? "unknown",
    requestId: randomUUID(),
    surface: "retrieval",
    attemptKey: "rewrite_tool",
  };

export class GatewayQueryRewritePortAdapter implements QueryRewritePort {
  constructor(private readonly gateway: QueryRewriteGateway) {}

  async rewrite(input: QueryRewritePortRequest): Promise<QueryRewritePortResult> {
    const original = input.query;
    try {
      const result = await this.gateway.rewrite({
        query: original,
        contextMessages: [],
        workspaceContext: input.workspaceContext,
        usageContext: { ...resolveUsageContext(input), operation: "query_interpretation" },
      });
      return {
        semantic: pickSemantic(result, original),
        lexical: pickLexical(result, original),
      };
    } catch {
      return { semantic: original, lexical: original };
    }
  }
}
