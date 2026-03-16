import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { normalizeIdentityPhrase } from "./subjectIdentityService.js";

export type EntityQueryMode = "generic" | "comparison" | "correction";

export interface EntityQueryIntent {
  mode: EntityQueryMode;
  includePhrases: string[];
  excludePhrases: string[];
}

export class EntityQueryIntentService {
  interpret(input: { query: string; history: MessageRecord[] }): EntityQueryIntent {
    const query = input.query.trim();

    const comparison = this.parseComparison(query);
    if (comparison.length >= 2) {
      return {
        mode: "comparison",
        includePhrases: comparison,
        excludePhrases: [],
      };
    }

    const correction = this.parseCorrection(query, input.history);
    if (correction) {
      return correction;
    }

    return {
      mode: "generic",
      includePhrases: [],
      excludePhrases: [],
    };
  }

  private parseComparison(query: string): string[] {
    const normalized = query.replace(/\?+$/, "").trim();
    const compareMatch = normalized.match(/^(?:compare|difference between)\s+(.+)$/i);
    if (compareMatch?.[1]) {
      return this.splitEntities(compareMatch[1]);
    }

    if (/\bvs\.?\b/i.test(normalized)) {
      return this.splitEntities(normalized.replace(/\bvs\.?\b/gi, " and "));
    }

    return [];
  }

  private parseCorrection(query: string, history: MessageRecord[]): EntityQueryIntent | null {
    const normalized = query.replace(/\?+$/, "").trim();
    const meantMatch = normalized.match(/^i meant\s+(.+?)(?:\s*,?\s*not\s+(.+))?$/i);
    if (meantMatch?.[1]) {
      return {
        mode: "correction",
        includePhrases: this.cleanupPhrases([meantMatch[1]]),
        excludePhrases: this.cleanupPhrases(meantMatch[2] ? [meantMatch[2]] : []),
      };
    }

    if (history.length === 0) {
      return null;
    }

    const notMatch = normalized.match(/^(.+?)\s*,?\s*not\s+(.+)$/i);
    if (notMatch?.[1] && notMatch?.[2]) {
      return {
        mode: "correction",
        includePhrases: this.cleanupPhrases([this.takeLeadingEntity(notMatch[1])]),
        excludePhrases: this.cleanupPhrases([this.takeLeadingEntity(notMatch[2])]),
      };
    }

    const isNotMatch = normalized.match(/^(.+?)\s+is not\b/i);
    if (isNotMatch?.[1]) {
      return {
        mode: "correction",
        includePhrases: this.cleanupPhrases([this.takeLeadingEntity(isNotMatch[1])]),
        excludePhrases: [],
      };
    }

    return null;
  }

  private splitEntities(value: string): string[] {
    return this.cleanupPhrases(
      value
        .split(/\band\b|,/i)
        .map((part) => this.takeLeadingEntity(part))
        .filter(Boolean),
    );
  }

  private takeLeadingEntity(value: string): string {
    return value
      .replace(/\b(?:who|what|where)\s+is\b/gi, "")
      .replace(/\b(?:was|were|is|are)\b.*$/i, "")
      .trim();
  }

  private cleanupPhrases(values: string[]): string[] {
    return values
      .map((value) => normalizeIdentityPhrase(value))
      .filter((value) => value.length > 1)
      .filter((value) => !/^\d+$/.test(value));
  }
}
