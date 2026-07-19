import { describe, expect, it } from "vitest";

import { diagnoseImplicitCitationSupport } from "../../src/modules/chat/services/implicitCitationDiagnostics.js";
import type { CitationEvidence } from "../../src/modules/chat/contracts/answerTypes.js";

const evidence: CitationEvidence[] = [
  {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Meditation Tips",
    content: "Keep meditation practice short and simple. Begin with a few minutes each day.",
  },
  {
    documentId: "doc-2",
    chunkId: "chunk-2",
    title: "Course Schedule",
    content: "Residential course registration opens in March and closes in May.",
  },
];

describe("implicit citation diagnostics", () => {
  it("reports aggregate overlap without creating citation artifacts", () => {
    expect(diagnoseImplicitCitationSupport([
      { text: "Keep meditation practice short and simple. " },
      { text: "Phone support is available 24/7." },
      { text: "Residential course registration opens in March.", citationIndices: [1] },
    ], evidence)).toEqual({
      eligibleSegmentCount: 2,
      implicitMatchCount: 1,
      explicitlyAssertedCount: 1,
    });
  });

  it("supports multilingual overlap and fails safely", () => {
    expect(diagnoseImplicitCitationSupport(
      [{ text: "Ananda offre corsi residenziali in Italiano." }],
      [{ documentId: "doc-3", chunkId: "chunk-3", title: "Corsi", content: "Ananda offre corsi residenziali in Italiano." }],
    )).toMatchObject({ eligibleSegmentCount: 1, implicitMatchCount: 1 });

    expect(diagnoseImplicitCitationSupport([], [])).toEqual({
      eligibleSegmentCount: 0,
      implicitMatchCount: 0,
      explicitlyAssertedCount: 0,
    });
  });
});
