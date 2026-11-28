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
 * search for the subject alone runs beside the model's own lexical searches. Lexical
 * search ranks chunks holding every term first, and a chunk holding only some of them
 * merely corroborates other evidence, so the subject is added as an alternative rather
 * than appended to, or substituted for, the terms the model chose.
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

/**
 * Whether the query names any word of the subject. A narrowing follow-up that swaps part of the
 * earlier question for another ("And the Pro plan?" after the Starter plan) keeps the rest of it,
 * so a query holding some of the subject's words already carries what the turn kept; joining the
 * whole subject would bring back the part the user replaced.
 */
const mentionsSubject = (query: string, subject: string): boolean => {
  const queryTokens = new Set(tokensOf(query));
  return tokensOf(subject).some((token) => queryTokens.has(token));
};

const joinSubjectToSemanticQuery = (semanticQuery: string, subject: string): string =>
  mentionsSubject(semanticQuery, subject) ? semanticQuery : `${subject}: ${semanticQuery}`;

const joinSubjectToLexicalQuery = (lexicalQuery: string, subject: string): string =>
  mentionsSubject(lexicalQuery, subject) ? lexicalQuery : `${lexicalQuery} ${subject}`;

const joinSubjectToBranch = (branch: RetrievalSubquery, subject: string): RetrievalSubquery => {
  const semanticQuery = joinSubjectToSemanticQuery(branch.semanticQuery, subject);
  const lexicalQuery = joinSubjectToLexicalQuery(branch.lexicalQuery, subject);
  if (lexicalQuery === branch.lexicalQuery) {
    return { ...branch, semanticQuery };
  }
  // A derived lexical plan reads the query the model wrote; the joined query is searched as written.
  const { lexicalPlan: _planOfTheModelQuery, ...unplanned } = branch;
  return { ...unplanned, semanticQuery, lexicalQuery };
};

/**
 * Keeps the earlier subject in a narrowing follow-up's searches. The turn asks the earlier
 * question again with something added ("I mean in the routine" after a question about
 * sensitive data), so its answer is where the subject meets the addition. A query that names
 * none of the subject gets it joined: the semantic query names it, and the lexical query holds
 * it beside the model's own terms, where lexical search ranks a chunk holding both first. A
 * query that names any of it is left as the model wrote it.
 *
 * The subject never runs as a search of its own: that search is the earlier question's, and it
 * finds the earlier answer again. When a join changes a search, the model's own query still runs
 * as one more search, so a turn labelled a narrowing that names a subject of its own ("What
 * about pricing?") keeps a search for what it asks.
 */
export const anchorNarrowingToSubject = (input: {
  subject: string;
  semanticQuery: string;
  lexicalQuery: string;
  retrievalSubqueries?: RetrievalSubquery[];
  responseLanguagePolicy: ResponseLanguagePolicy;
  labelFor: (text: string, position: number) => string;
}): { semanticQuery: string; lexicalQuery: string; retrievalSubqueries?: RetrievalSubquery[]; anchored: boolean } => {
  const modelBranches: RetrievalSubquery[] = input.retrievalSubqueries ?? [{
    id: "subquery_1",
    label: input.labelFor(input.lexicalQuery, 1),
    semanticQuery: input.semanticQuery,
    lexicalQuery: input.lexicalQuery,
    responseLanguagePolicy: input.responseLanguagePolicy,
  }];
  const joinedBranches = modelBranches.map((branch) => joinSubjectToBranch(branch, input.subject));
  const semanticQuery = joinSubjectToSemanticQuery(input.semanticQuery, input.subject);
  const lexicalQuery = joinSubjectToLexicalQuery(input.lexicalQuery, input.subject);
  const anchored = semanticQuery !== input.semanticQuery
    || lexicalQuery !== input.lexicalQuery
    || joinedBranches.some((branch, index) =>
      branch.semanticQuery !== modelBranches[index].semanticQuery || branch.lexicalQuery !== modelBranches[index].lexicalQuery);
  if (!anchored) {
    return { semanticQuery, lexicalQuery, retrievalSubqueries: input.retrievalSubqueries, anchored };
  }

  return {
    semanticQuery,
    lexicalQuery,
    retrievalSubqueries: [
      ...joinedBranches,
      {
        // Model subquery ids can skip numbers, so this one is named rather than numbered.
        id: "model_query",
        label: input.labelFor(input.lexicalQuery, joinedBranches.length + 1),
        semanticQuery: input.semanticQuery,
        lexicalQuery: input.lexicalQuery,
        reason: "model_query",
        responseLanguagePolicy: input.responseLanguagePolicy,
      },
    ],
    anchored,
  };
};
