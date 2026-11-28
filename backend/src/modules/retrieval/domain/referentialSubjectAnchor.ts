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

/** The lexical query with the subject's words beside the model's own, unless it already names every one. */
const joinSubjectToLexicalQuery = (lexicalQuery: string, subject: string): string =>
  namesSubject(lexicalQuery, subject) ? lexicalQuery : `${lexicalQuery} ${subject}`;

const joinSubjectToBranch = (branch: RetrievalSubquery, subject: string): RetrievalSubquery => {
  const semanticQuery = anchorSemanticQuery(branch.semanticQuery, subject);
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
 * sensitive data), so its answer is where the subject meets the addition. A query that lacks
 * any word of the subject gets the whole subject joined: the semantic query names it, and the
 * lexical query holds it beside the model's own terms, where lexical search ranks a chunk
 * holding both first. A query that names every word is left as the model wrote it.
 *
 * Joining on any missing word restores a subject the model half dropped ("sensitive data" written
 * as "data"), and a function word the query shares with the subject cannot switch the join off.
 * The price is a follow-up that swaps part of the question: joined to the earlier subject whole,
 * it would search the part the user replaced. The interpreter prevents that by the subject it
 * proposes, not by this check: a swap of the subject is a recenter, which anchors nothing, and a
 * swap of a place or option keeps only the part both questions share as the subject.
 *
 * The subject never runs as a search of its own: that search is the earlier question's, and it
 * finds the earlier answer again. When a join changes a search, the model's own top-level query
 * runs as one more search, so a mislabelled turn (a swap, or a subject of its own such as "What
 * about pricing?") keeps one search for what it asks. When the model wrote two or more subqueries,
 * their semantic queries already fill the per-turn semantic cap, so that search is lexical only.
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
  const semanticQuery = anchorSemanticQuery(input.semanticQuery, input.subject);
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
