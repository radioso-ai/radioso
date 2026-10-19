import type { ResponseLanguagePolicy, RetrievalSubquery } from "./retrievalPipelineTypes.js";

/** Letters, marks, and digits in any script; everything else separates tokens. */
const tokensOf = (value: string): string[] => value.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

/** Whether every token of the subject appears as a whole token of the query. */
const namesSubject = (query: string, subject: string): boolean => {
  const subjectTokens = tokensOf(subject);
  const queryTokens = new Set(tokensOf(query));
  return subjectTokens.length > 0 && subjectTokens.every((token) => queryTokens.has(token));
};

/** Whether a lexical query searches for the subject and nothing else. */
const searchesSubjectAlone = (lexicalQuery: string, subject: string): boolean => {
  const subjectTokens = new Set(tokensOf(subject));
  const queryTokens = new Set(tokensOf(lexicalQuery));
  return namesSubject(lexicalQuery, subject) && [...queryTokens].every((token) => subjectTokens.has(token));
};

const anchorSemanticQuery = (semanticQuery: string, subject: string): string =>
  namesSubject(semanticQuery, subject) ? semanticQuery : `${subject}: ${semanticQuery}`;

/**
 * Makes sure the subject a referential turn resolved to reaches retrieval when the
 * model's queries left it out. Every semantic query names the subject, and a lexical
 * search for the subject alone runs beside the model's own lexical searches: lexical
 * search requires every term, so the subject is added as an alternative rather than
 * appended to, or substituted for, the terms the model chose.
 *
 * Without model subqueries the model's single query becomes the first branch; the
 * subject search shares its semantic query, so it costs no extra embedding.
 */
export const anchorRetrievalToSubject = (input: {
  subject: string;
  semanticQuery: string;
  lexicalQuery: string;
  retrievalSubqueries?: RetrievalSubquery[];
  responseLanguagePolicy: ResponseLanguagePolicy;
  labelFor: (text: string, position: number) => string;
}): { semanticQuery: string; retrievalSubqueries?: RetrievalSubquery[]; anchored: boolean } => {
  const semanticQuery = anchorSemanticQuery(input.semanticQuery, input.subject);
  const branches: RetrievalSubquery[] = input.retrievalSubqueries ?? [{
    id: "subquery_1",
    label: input.labelFor(input.lexicalQuery, 1),
    semanticQuery: input.semanticQuery,
    lexicalQuery: input.lexicalQuery,
    responseLanguagePolicy: input.responseLanguagePolicy,
  }];
  const anchoredBranches = branches.map((branch) => ({
    ...branch,
    semanticQuery: anchorSemanticQuery(branch.semanticQuery, input.subject),
  }));
  const semanticAnchored = anchoredBranches.some((branch, index) => branch.semanticQuery !== branches[index].semanticQuery);
  if (anchoredBranches.some((branch) => searchesSubjectAlone(branch.lexicalQuery, input.subject))) {
    return {
      semanticQuery,
      retrievalSubqueries: input.retrievalSubqueries ? anchoredBranches : undefined,
      anchored: semanticAnchored,
    };
  }

  return {
    semanticQuery,
    retrievalSubqueries: [
      ...anchoredBranches,
      {
        // Model subquery ids can skip numbers, so this one is named rather than numbered.
        id: "referential_subject",
        label: input.labelFor(input.subject, anchoredBranches.length + 1),
        semanticQuery: anchoredBranches[0].semanticQuery,
        lexicalQuery: input.subject,
        reason: "referential_subject",
        responseLanguagePolicy: input.responseLanguagePolicy,
      },
    ],
    anchored: true,
  };
};
