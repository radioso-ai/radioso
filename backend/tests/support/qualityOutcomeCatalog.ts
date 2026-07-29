import type {
  QualityOutcomeCatalogEntry,
  QualityOutcomeCatalogPort,
} from "../../src/modules/quality/domain/qualitySignals.js";

/**
 * Fixed skill-outcome catalog for quality tests. Mirrors the built-in retrieval skill:
 * one grounded outcome, two ungrounded ones, and a clarification outcome that omits the
 * flag entirely and so belongs to neither side.
 */
export const DEFAULT_QUALITY_OUTCOME_CATALOG: readonly QualityOutcomeCatalogEntry[] = [
  {
    name: "retrieval.answer",
    outcomes: [
      { name: "grounded", groundedAnswer: true },
      { name: "no_context", groundedAnswer: false },
      { name: "degraded", groundedAnswer: false },
      { name: "clarification_needed" },
    ],
  },
];

export const stubOutcomeCatalog = (
  entries: readonly QualityOutcomeCatalogEntry[] = DEFAULT_QUALITY_OUTCOME_CATALOG,
): QualityOutcomeCatalogPort => ({
  async listOutcomeCatalog() {
    return entries;
  },
});
