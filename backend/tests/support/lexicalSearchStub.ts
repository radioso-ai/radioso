import {
  skippedSomeTermsPass,
  type LexicalSomeTermsPassReport,
} from "../../src/modules/retrieval/domain/lexicalSomeTermsMatch.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/domain/vectorSearch.js";
import type { LexicalSearchInput, LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";

/**
 * A lexical search port over a fake that returns matches only. The some-terms pass
 * reports `skipped` unless the test gives it a report of its own.
 */
export const lexicalSearchStub = (
  fake: { search(input: LexicalSearchInput): Promise<RetrievedChunk[]> },
  someTermsPass: LexicalSomeTermsPassReport = skippedSomeTermsPass("nothing_to_relax"),
): LexicalSearchPort => ({
  async search(input) {
    return { matches: await fake.search(input), someTermsPass };
  },
});
