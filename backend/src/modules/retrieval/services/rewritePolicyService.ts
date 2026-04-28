import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ContinuityDecision, StructuredRewriteResult } from "../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../infra/vectorSearch.js";

export interface RewriteValidationResult {
  materialDisagreement: boolean;
  continuityDecision: ContinuityDecision;
  rejectionReason?: string;
}

const NO_SUPPORT = 0;
const INCIDENTAL_SUPPORT = 1;
const CENTERED_SUPPORT = 2;

export class RewriteEligibilityService {
  evaluate(input: {
    originalQuery: string;
    rewrite: StructuredRewriteResult;
  }): { eligible: boolean; rejectionReason?: string } {
    const semanticQuery = input.rewrite.semanticQuery ?? input.rewrite.rewrittenQuery;
    const lexicalQuery = input.rewrite.lexicalQuery ?? input.rewrite.rewrittenQuery;
    const retrievalSubqueries = input.rewrite.retrievalSubqueries ?? [];

    if (retrievalSubqueries.length > 1) {
      return { eligible: true };
    }

    const semanticMaterial = this.isMateriallyDifferent(input.originalQuery, semanticQuery);
    const lexicalMaterial =
      this.isMateriallyDifferent(input.originalQuery, lexicalQuery) ||
      this.isFocusedLexicalQuery(input.originalQuery, lexicalQuery);

    if (!semanticMaterial && !lexicalMaterial) {
      return { eligible: false, rejectionReason: "rewrite_not_materially_different" };
    }

    return { eligible: true };
  }

  private isFocusedLexicalQuery(originalQuery: string, rewrittenQuery: string): boolean {
    const originalTerms = this.normalizeTerms(originalQuery);
    const rewrittenTerms = this.normalizeTerms(rewrittenQuery);

    if (rewrittenTerms.length === 0 || originalTerms.length === 0) {
      return false;
    }

    if (rewrittenTerms.join(" ") === originalTerms.join(" ")) {
      return false;
    }

    const originalTermSet = new Set(originalTerms);
    const removesTerms = rewrittenTerms.length < originalTerms.length;
    const staysAnchored = rewrittenTerms.every((term) => originalTermSet.has(term));

    return removesTerms && staysAnchored;
  }

  private isMateriallyDifferent(originalQuery: string, rewrittenQuery: string): boolean {
    const original = this.normalizeTerms(originalQuery).join(" ");
    const rewritten = this.normalizeTerms(rewrittenQuery).join(" ");

    if (!rewritten || rewritten === original) {
      return false;
    }

    const originalTerms = new Set(original.split(" "));
    const rewrittenTerms = rewritten.split(" ");
    const newTerms = rewrittenTerms.filter((term) => !originalTerms.has(term));

    return newTerms.length > 0;
  }

  private normalizeTerms(value: string): string[] {
    return value.trim().replace(/\s+/g, " ").toLowerCase().split(" ").filter((term) => term.length > 0);
  }
}

export class RewriteHallucinationGuard {
  evaluate(input: {
    query: string;
    history: MessageRecord[];
    rewrite: StructuredRewriteResult;
  }): { accepted: boolean; rejectionReason?: string } {
    const knownText = [
      input.query,
      ...input.history.filter((message) => message.role === "user").map((message) => message.content),
    ].join(" ");
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

    if (
      input.rewrite.turnKind === "referential_relation" &&
      proposed &&
      input.rewrite.relatedEntities.some((entity) => entity.toLowerCase() === proposed.toLowerCase())
    ) {
      return { accepted: false, rejectionReason: "rewrite_relation_subject_collision" };
    }

    return { accepted: true };
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

    const rawSupport = this.strongestEntitySupport(input.rawContexts, subject);
    const rewrittenSupport = this.strongestEntitySupport(input.rewrittenContexts, subject);
    const competingEntity = input.rewrite.relatedEntities.find((entity) => entity.toLowerCase() !== subject.toLowerCase());
    const competingSupport = competingEntity ? this.strongestEntitySupport(input.rawContexts, competingEntity) : NO_SUPPORT;

    if (input.rewrite.unresolved) {
      return {
        materialDisagreement: true,
        continuityDecision: "unresolved",
        rejectionReason: "rewrite_unresolved",
      };
    }

    if (rewrittenSupport === NO_SUPPORT) {
      return {
        materialDisagreement: true,
        continuityDecision: "rejected",
        rejectionReason:
          rawSupport === NO_SUPPORT ? "rewrite_subject_not_supported" : "rewrite_subject_not_supported_in_rewrite",
      };
    }

    if (rawSupport === INCIDENTAL_SUPPORT) {
      return {
        materialDisagreement: true,
        continuityDecision: "rejected",
        rejectionReason: "rewrite_subject_only_incidental_in_raw",
      };
    }

    if (competingSupport > rawSupport && rewrittenSupport > NO_SUPPORT) {
      return {
        materialDisagreement: true,
        continuityDecision: "rejected",
        rejectionReason: "rewrite_subject_role_changed",
      };
    }

    return {
      materialDisagreement: false,
      continuityDecision: rawSupport > NO_SUPPORT || rewrittenSupport > NO_SUPPORT ? "reused" : "unchanged",
    };
  }

  private strongestEntitySupport(contexts: RetrievedChunk[], entity: string): number {
    const needle = entity.toLowerCase();
    return contexts.reduce((best, context) => {
      const haystack = `${context.title} ${context.content}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return best;
      }

      const normalizedTitle = context.title.toLowerCase();
      const normalizedContent = context.content.toLowerCase().trim();
      const support =
        normalizedTitle.includes(needle) || normalizedContent.startsWith(needle)
          ? CENTERED_SUPPORT
          : INCIDENTAL_SUPPORT;

      return Math.max(best, support);
    }, NO_SUPPORT);
  }
}
