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

export class GatewayQueryRewritePortAdapter implements QueryRewritePort {
  constructor(private readonly gateway: QueryRewriteGateway) {}

  async rewrite(input: QueryRewritePortRequest): Promise<QueryRewritePortResult> {
    const original = input.query;
    try {
      const result = await this.gateway.rewrite({
        query: original,
        contextMessages: [],
        workspaceContext: input.workspaceContext,
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
