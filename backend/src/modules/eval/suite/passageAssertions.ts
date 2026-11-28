import type { ConversationQualityObservedOutput } from "./observedOutput.js";

/**
 * What a passage assertion expects: the passage of `documentId` whose text holds `passage` ranks
 * within the first `k`. A page's sections are separate passages of one document, so this tells the
 * section that answers from passages that name the same item in passing, which a document-level
 * retrieval assertion cannot.
 */
export interface PassageExpectation {
  documentId: string;
  passage: string;
  k: number;
}

/** A passage of `documentId` whose text holds `passage`, which no lexical search may hold as a full match. */
export type PassageExclusion = Omit<PassageExpectation, "k">;

const PASSAGE_ASSERTION_TYPES = new Set([
  "retrieval_lexical_top_k_includes_passage",
  "retrieval_lexical_full_matches_exclude_passage",
  "retrieval_answer_top_k_includes_passage",
]);

type Verdict =
  | { status: "pass"; reason: string }
  | { status: "fail"; reason: string }
  | { status: "error"; reason: string };

interface PassageRef {
  chunkId: string;
  documentId: string;
}

interface LexicalSearch {
  query: string;
  /** In rank order; a part match holds only some of the search's terms. */
  hits: Array<PassageRef & { partMatch: boolean }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readHits = (value: unknown): LexicalSearch["hits"] =>
  (Array.isArray(value) ? value : []).flatMap((hit) =>
    isRecord(hit) && typeof hit.chunkId === "string" && typeof hit.documentId === "string"
      ? [{ chunkId: hit.chunkId, documentId: hit.documentId, partMatch: hit.lexicalTermCoverage === "some_terms" }]
      : []);

/**
 * The lexical searches the turn's retrieval ran, each with its hits in rank order: every `lexical`
 * stage of the retrieval capability's sub-trace, one per lexical alternative or subquery.
 */
const lexicalSearches = (output: ConversationQualityObservedOutput): LexicalSearch[] =>
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
      PASSAGE_ASSERTION_TYPES.has(assertion.type) && "documentId" in assertion ? [String(assertion.documentId)] : []),
  ),
];

/**
 * The passage texts the runner read for the named document, or an error verdict: the trace names
 * passages by id only, so a missing text is an error of the run, not a verdict.
 */
const readTexts = (
  expectation: PassageExclusion,
  output: ConversationQualityObservedOutput,
  refs: readonly PassageRef[],
): { texts: Record<string, string> } | { error: Verdict } => {
  const texts = output.passageTexts;
  const documentRefs = refs.filter((ref) => ref.documentId === expectation.documentId);
  if (!texts || documentRefs.some((ref) => texts[ref.chunkId] === undefined)) {
    return { error: { status: "error", reason: `The runner read no passage texts of document ${expectation.documentId}.` } };
  }
  return { texts };
};

const holdsPassage = (expectation: PassageExclusion, texts: Record<string, string>) => (ref: PassageRef): boolean =>
  ref.documentId === expectation.documentId && (texts[ref.chunkId] ?? "").includes(expectation.passage);

/**
 * Judges whether every lexical search of the turn holds the passage as a part match at most: a
 * passage that names an item in passing must never count as evidence that it answers.
 */
export const judgeLexicalFullMatchExclusion = (expectation: PassageExclusion, output: ConversationQualityObservedOutput): Verdict => {
  if (!output.turnTrace) {
    return { status: "error", reason: "No turnTrace was captured for this run, so its lexical searches cannot be read." };
  }
  const searches = lexicalSearches(output);
  const read = readTexts(expectation, output, searches.flatMap((search) => search.hits));
  if ("error" in read) {
    return read.error;
  }
  const holds = holdsPassage(expectation, read.texts);
  const fullMatches = searches.filter((search) => search.hits.some((hit) => holds(hit) && !hit.partMatch));
  if (fullMatches.length > 0) {
    return {
      status: "fail",
      reason: `Lexical search ${fullMatches.map((search) => `"${search.query}"`).join(", ")} held the passage holding "${expectation.passage}" as a full match.`,
    };
  }
  return { status: "pass", reason: `No lexical search held the passage holding "${expectation.passage}" as a full match.` };
};

/**
 * Judges whether one of the turn's lexical searches ranks the passage as full evidence within its
 * first `k` hits. A part match never counts: it corroborates other evidence and never leads.
 */
export const judgeLexicalPassage = (expectation: PassageExpectation, output: ConversationQualityObservedOutput): Verdict => {
  if (!output.turnTrace) {
    return { status: "error", reason: "No turnTrace was captured for this run, so its lexical searches cannot be read." };
  }
  const searches = lexicalSearches(output);
  const read = readTexts(expectation, output, searches.flatMap((search) => search.hits));
  if ("error" in read) {
    return read.error;
  }
  const holds = holdsPassage(expectation, read.texts);
  const ranks = searches.map((search) => {
    const index = search.hits.findIndex(holds);
    return { query: search.query, rank: index + 1, partMatch: search.hits[index]?.partMatch ?? false };
  });
  const found = ranks.find((search) => search.rank > 0 && search.rank <= expectation.k && !search.partMatch);
  if (found) {
    return {
      status: "pass",
      reason: `Lexical search "${found.query}" ranked the passage holding "${expectation.passage}" at ${found.rank} of its hits.`,
    };
  }
  const observed = ranks
    .map((search) => `"${search.query}": ${search.rank === 0 ? "not among its hits" : `at ${search.rank}${search.partMatch ? " as a part match" : ""}`}`)
    .join("; ");
  return {
    status: "fail",
    reason: `No lexical search ranked the passage holding "${expectation.passage}" as full evidence within its first ${expectation.k} hits (${observed || "no lexical search ran"}).`,
  };
};

/** Judges whether the passage is among the first `k` passages the answer was written from. */
export const judgeAnswerPassage = (expectation: PassageExpectation, output: ConversationQualityObservedOutput): Verdict => {
  const admitted = [...output.retrievedChunks].sort((left, right) => left.rank - right.rank);
  const read = readTexts(expectation, output, admitted);
  if ("error" in read) {
    return read.error;
  }
  const position = admitted.findIndex(holdsPassage(expectation, read.texts)) + 1;
  if (position > 0 && position <= expectation.k) {
    return { status: "pass", reason: `The answer read the passage holding "${expectation.passage}" at ${position} of its passages.` };
  }
  return {
    status: "fail",
    reason: position > 0
      ? `The answer read the passage holding "${expectation.passage}" at ${position} of its passages, past the first ${expectation.k}.`
      : `The answer's ${admitted.length} passages do not hold "${expectation.passage}".`,
  };
};
