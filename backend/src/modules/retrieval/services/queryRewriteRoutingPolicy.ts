import type { ResponseIntent, StructuredRewriteResult } from "../domain/retrievalPipelineTypes.js";
import { RESPONSE_INTENT } from "../domain/retrievalPipelineTypes.js";

const PROCEDURAL_LOOKUP_PATTERN =
  /\b(?:how\s+(?:do|can|could|should)\s+i|how\s+to|where\s+(?:do|can|could|should)\s+i|what\s+(?:do|should)\s+i\s+do|can\s+i|could\s+i|is\s+it\s+possible\s+to|i\s+(?:can'?t|cannot)\s+(?:access|log\s*in|login|sign\s*in|change|reset|recover|find|book|register|enroll|cancel|update)|help\s+me\s+(?:access|log\s*in|login|sign\s*in|change|reset|recover|find|book|register|enroll|cancel|update)|need\s+help\s+(?:with|to))\b/i;

const SELF_CONTAINED_NON_RETRIEVAL_PATTERN =
  /\b(?:arithmetic|calculate|calculation|compute|equation|math|sqrt|square\s+root|python|javascript|typescript|java|regex|sql|code|coding|programming|syntax|debug|translate|translation|trivia|joke|poem|story|draft\s+(?:an?\s+)?(?:email|message|letter|reply)|medical|legal|financial|relationship)\b/i;

export class QueryRewriteRoutingPolicy {
  chooseResponseIntent(input: {
    query: string;
    result: StructuredRewriteResult;
    normalizedResponseIntent: ResponseIntent;
  }): ResponseIntent {
    if (
      this.shouldRouteScopeClassifiedRequestToRetrieval(input.result, input.normalizedResponseIntent)
      || this.shouldRescueProceduralQuery(input.query, input.result, input.normalizedResponseIntent)
    ) {
      return RESPONSE_INTENT.RETRIEVAL;
    }

    return input.normalizedResponseIntent;
  }

  private shouldRescueProceduralQuery(
    query: string,
    result: StructuredRewriteResult,
    normalizedResponseIntent: ResponseIntent,
  ): boolean {
    if (normalizedResponseIntent !== RESPONSE_INTENT.SOCIAL_ONLY) {
      return false;
    }

    const classifierText = [
      query,
      result.intentTopic,
      result.inScopeRequest,
      result.outsideScopeRequest,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");

    if (SELF_CONTAINED_NON_RETRIEVAL_PATTERN.test(classifierText)) {
      return false;
    }

    return PROCEDURAL_LOOKUP_PATTERN.test(query);
  }

  private shouldRouteScopeClassifiedRequestToRetrieval(
    result: StructuredRewriteResult,
    normalizedResponseIntent: ResponseIntent,
  ): boolean {
    if (normalizedResponseIntent !== RESPONSE_INTENT.SOCIAL_ONLY) {
      return false;
    }

    const hasScopeRequest =
      (typeof result.inScopeRequest === "string" && result.inScopeRequest.trim().length > 0)
      || (typeof result.outsideScopeRequest === "string" && result.outsideScopeRequest.trim().length > 0);

    return hasScopeRequest;
  }
}
