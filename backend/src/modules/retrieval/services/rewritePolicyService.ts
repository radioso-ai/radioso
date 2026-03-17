import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ContinuityDecision, StructuredRewriteResult } from "../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";

export interface RewriteValidationResult {
  materialDisagreement: boolean;
  continuityDecision: ContinuityDecision;
  rejectionReason?: string;
}

const RELATION_PATTERN = /\b(with|about|vs\.?|versus|compared to|than)\b/i;
const ENTITY_PATTERN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
const QUESTION_WORDS = new Set(["What", "Who", "When", "Where", "Why", "How", "Is", "Are", "Does", "Do", "Can", "And", "But", "Or"]);

export class RewriteEligibilityService {
  evaluate(input: {
    originalQuery: string;
    rewrite: StructuredRewriteResult;
  }): { eligible: boolean; rejectionReason?: string } {
    if (input.rewrite.unresolved) {
      return { eligible: false, rejectionReason: "rewrite_unresolved" };
    }

    if (!this.isMateriallyDifferent(input.originalQuery, input.rewrite.rewrittenQuery)) {
      return { eligible: false, rejectionReason: "rewrite_not_materially_different" };
    }

    return { eligible: true };
  }

  private isMateriallyDifferent(originalQuery: string, rewrittenQuery: string): boolean {
    const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    const original = normalize(originalQuery);
    const rewritten = normalize(rewrittenQuery);

    if (!rewritten || rewritten === original) {
      return false;
    }

    const originalTerms = new Set(original.split(" "));
    const rewrittenTerms = rewritten.split(" ");
    const newTerms = rewrittenTerms.filter((term) => !originalTerms.has(term));

    return newTerms.length > 0;
  }
}

export class RewriteHallucinationGuard {
  evaluate(input: {
    query: string;
    history: MessageRecord[];
    rewrite: StructuredRewriteResult;
  }): { accepted: boolean; rejectionReason?: string } {
    const knownText = [input.query, ...input.history.map((message) => message.content)].join(" ");
    const normalizedKnown = knownText.toLowerCase();
    const proposed = input.rewrite.proposedActiveSubject?.trim();

    if (proposed && !normalizedKnown.includes(proposed.toLowerCase())) {
      return { accepted: false, rejectionReason: "rewrite_subject_ungrounded" };
    }

    for (const entity of input.rewrite.relatedEntities) {
      if (!normalizedKnown.includes(entity.toLowerCase())) {
        return { accepted: false, rejectionReason: "rewrite_related_entity_ungrounded" };
      }
    }

    const explicitEntities = this.extractEntities(input.query);
    if (
      explicitEntities.length > 0 &&
      input.rewrite.turnKind === "fresh_subject" &&
      proposed &&
      !explicitEntities.some((entity) => entity.toLowerCase() === proposed.toLowerCase())
    ) {
      return { accepted: false, rejectionReason: "rewrite_explicit_subject_mismatch" };
    }

    if (
      input.rewrite.turnKind === "referential_relation" &&
      proposed &&
      input.rewrite.relatedEntities.some((entity) => entity.toLowerCase() === proposed.toLowerCase())
    ) {
      return { accepted: false, rejectionReason: "rewrite_relation_subject_collision" };
    }

    if (
      explicitEntities.length === 1 &&
      proposed &&
      !RELATION_PATTERN.test(input.query) &&
      explicitEntities[0]?.toLowerCase() !== proposed.toLowerCase()
    ) {
      return { accepted: false, rejectionReason: "rewrite_explicit_subject_mismatch" };
    }

    return { accepted: true };
  }

  private extractEntities(text: string): string[] {
    return [...new Set((text.match(ENTITY_PATTERN) ?? []).filter((entity) => !QUESTION_WORDS.has(entity)))];
  }
}

export class RetrievalEvidenceComparisonService {
  compare(input: {
    query: string;
    rewrite: StructuredRewriteResult;
    rawContexts: RetrievedChunk[];
    rewrittenContexts: RetrievedChunk[];
  }): RewriteValidationResult {
    const subject = input.rewrite.proposedActiveSubject?.trim();
    if (!subject) {
      return {
        materialDisagreement: input.rewrite.unresolved,
        continuityDecision: input.rewrite.unresolved ? "unresolved" : "unchanged",
      };
    }

    const rawSupport = this.countEntitySupport(input.rawContexts, subject);
    const rewrittenSupport = this.countEntitySupport(input.rewrittenContexts, subject);
    const competingEntity = input.rewrite.relatedEntities.find((entity) => entity.toLowerCase() !== subject.toLowerCase());
    const competingSupport = competingEntity ? this.countEntitySupport(input.rawContexts, competingEntity) : 0;

    if (input.rewrite.unresolved) {
      return {
        materialDisagreement: true,
        continuityDecision: "unresolved",
        rejectionReason: "rewrite_unresolved",
      };
    }

    if (rewrittenSupport === 0 && rawSupport === 0) {
      return {
        materialDisagreement: true,
        continuityDecision: "rejected",
        rejectionReason: "rewrite_subject_not_supported",
      };
    }

    if (competingSupport > rawSupport && rewrittenSupport > 0) {
      return {
        materialDisagreement: true,
        continuityDecision: "rejected",
        rejectionReason: "rewrite_subject_role_changed",
      };
    }

    return {
      materialDisagreement: false,
      continuityDecision: rawSupport > 0 || rewrittenSupport > 0 ? "reused" : "unchanged",
    };
  }

  private countEntitySupport(contexts: RetrievedChunk[], entity: string): number {
    const needle = entity.toLowerCase();
    return contexts.reduce((count, context) => {
      const haystack = `${context.title} ${context.content}`.toLowerCase();
      return haystack.includes(needle) ? count + 1 : count;
    }, 0);
  }
}
