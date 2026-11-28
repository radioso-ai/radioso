import type { EvalRunObservedOutput } from "../domain/types.js";

/**
 * What a lexical passage assertion expects: one of the turn's lexical searches ranks the passage of
 * `documentId` whose text holds `passage` within its first `k` hits. A page's sections are separate
 * passages of one document, so this tells the section that answers from passages that name the same
 * item in passing, which a document-level retrieval assertion cannot.
 */
export interface LexicalPassageExpectation {
  documentId: string;
  passage: string;
  k: number;
}

type Verdict =
  | { status: "pass"; reason: string }
  | { status: "fail"; reason: string }
  | { status: "error"; reason: string };

interface LexicalSearch {
  query: string;
  hits: Array<{ chunkId: string; documentId: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readHits = (value: unknown): LexicalSearch["hits"] =>
  (Array.isArray(value) ? value : []).flatMap((hit) =>
    isRecord(hit) && typeof hit.chunkId === "string" && typeof hit.documentId === "string"
      ? [{ chunkId: hit.chunkId, documentId: hit.documentId }]
      : []);

/**
 * The lexical searches the turn's retrieval ran, each with its hits in rank order: every `lexical`
 * stage of the retrieval capability's sub-trace, one per lexical alternative or subquery.
 */
const lexicalSearches = (output: EvalRunObservedOutput): LexicalSearch[] =>
  (output.turnTrace?.spine?.stages ?? []).flatMap((stage) => {
    const payload = stage.subTrace?.namespace === "retrieval" ? stage.subTrace.payload : undefined;
    const stages = isRecord(payload) && Array.isArray(payload.stages) ? payload.stages : [];
    return stages.flatMap((candidate: unknown) => {
      if (!isRecord(candidate) || candidate.kind !== "lexical") {
        return [];
      }
      const query = isRecord(candidate.settings) && typeof candidate.settings.query === "string" ? candidate.settings.query : "";
      return [{ query, hits: readHits(isRecord(candidate.outputs) ? candidate.outputs.chunks : undefined) }];
    });
  });

/** The documents whose passage texts a case's assertions need, for the runner to read after the turn. */
export const passageAssertionDocumentIds = (assertions: ReadonlyArray<{ type: string }>): string[] => [
  ...new Set(
    assertions.flatMap((assertion) =>
      assertion.type === "retrieval_lexical_top_k_includes_passage" && "documentId" in assertion
        ? [String(assertion.documentId)]
        : []),
  ),
];

/**
 * Judges the expectation from the turn's lexical searches and the passage texts the runner read.
 * The trace names passages by id only, so a missing text is an error of the run, not a verdict.
 */
export const judgeLexicalPassage = (
  expectation: LexicalPassageExpectation,
  output: EvalRunObservedOutput & { passageTexts?: Record<string, string> },
): Verdict => {
  if (!output.turnTrace) {
    return { status: "error", reason: "No turnTrace was captured for this run, so its lexical searches cannot be read." };
  }
  const texts = output.passageTexts ?? {};
  const searches = lexicalSearches(output);
  const documentHits = searches.flatMap((search) => search.hits).filter((hit) => hit.documentId === expectation.documentId);
  if (!output.passageTexts || documentHits.some((hit) => texts[hit.chunkId] === undefined)) {
    return { status: "error", reason: `The runner read no passage texts of document ${expectation.documentId}.` };
  }
  const holdsPassage = (hit: { chunkId: string; documentId: string }): boolean =>
    hit.documentId === expectation.documentId && (texts[hit.chunkId] ?? "").includes(expectation.passage);
  const ranks = searches.map((search) => ({ query: search.query, rank: search.hits.findIndex(holdsPassage) + 1 }));
  const found = ranks.find((search) => search.rank > 0 && search.rank <= expectation.k);
  if (found) {
    return {
      status: "pass",
      reason: `Lexical search "${found.query}" ranked the passage holding "${expectation.passage}" at ${found.rank} of its hits.`,
    };
  }
  const observed = ranks
    .map((search) => `"${search.query}": ${search.rank > 0 ? `at ${search.rank}` : "not among its hits"}`)
    .join("; ");
  return {
    status: "fail",
    reason: `No lexical search ranked the passage holding "${expectation.passage}" within its first ${expectation.k} hits (${observed || "no lexical search ran"}).`,
  };
};
