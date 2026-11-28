import { describe, expect, it } from "vitest";

import {
  buildLexicalAlternativeSubqueries,
  deriveLexicalAlternatives,
  deriveLexicalQueryPlan,
  expandLexicalAlternatives,
} from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import type { RetrievalSubquery } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

describe("lexical query plan normalization", () => {
  it("splits top-level OR alternatives while preserving quoted phrases", () => {
    expect(deriveLexicalAlternatives('"forgot password" OR "reset token" OR SSO')).toEqual([
      '"forgot password"',
      '"reset token"',
      "SSO",
    ]);
  });

  it("deduplicates, trims, and caps alternatives", () => {
    expect(
      deriveLexicalAlternatives(' "Reset Token" OR reset token OR email link OR magic link OR backup code ', {
        maxAlternatives: 3,
      }),
    ).toEqual(['"Reset Token"', "email link", "magic link"]);
  });

  it("keeps ordinary lexical text as one fallback alternative", () => {
    expect(deriveLexicalAlternatives("password reset token")).toEqual(["password reset token"]);
  });

  it("drops alternatives without searchable content", () => {
    expect(deriveLexicalAlternatives('"..." OR "---" OR reset')).toEqual(["reset"]);
  });

  it("represents phrases, required terms, and exclusions in the internal plan", () => {
    expect(deriveLexicalQueryPlan('"reset token" expired -revoked')).toEqual({
      options: [
        {
          label: "reset token expired -revoked",
          lexicalQuery: '"reset token" expired -revoked',
          phrases: ["reset token"],
          requiredTerms: ["expired"],
          excludedTerms: ["revoked"],
        },
      ],
    });
  });
});

describe("lexical relaxations", () => {
  const relaxations = (lexicalQuery: string) =>
    deriveLexicalQueryPlan(lexicalQuery).options.map((option) => [option.label, option.relaxationOf]);

  it("marks an alternative whose terms are a strict part of a sibling's as that sibling's relaxation", () => {
    expect(relaxations("Planet plan OR Planet")).toEqual([
      ["Planet plan", undefined],
      ["Planet", ["planet", "plan"]],
    ]);
  });

  it("relaxes the closest sibling when several hold its terms", () => {
    expect(relaxations("Planet plan price OR Planet plan OR Planet")).toEqual([
      ["Planet plan price", undefined],
      ["Planet plan", ["planet", "plan", "price"]],
      ["Planet", ["planet", "plan"]],
    ]);
  });

  it("marks no relaxation between alternatives that share terms without one holding the other", () => {
    expect(relaxations("Planet plan OR Satellite plan")).toEqual([
      ["Planet plan", undefined],
      ["Satellite plan", undefined],
    ]);
  });

  it("compares terms in any script, whatever their case", () => {
    expect(relaxations("тариф Планета OR планета")).toEqual([
      ["тариф Планета", undefined],
      ["планета", ["тариф", "планета"]],
    ]);
  });

  it("carries the relaxation onto the alternative's subquery", () => {
    const subqueries = buildLexicalAlternativeSubqueries({
      semanticQuery: "Planet plan price",
      lexicalQuery: "Planet plan OR Planet",
      responseLanguagePolicy: "match_user_question",
    });

    expect(subqueries?.map((subquery) => subquery.lexicalPlan?.options[0]?.relaxationOf)).toEqual([
      undefined,
      ["planet", "plan"],
    ]);
  });
});

describe("lexical alternatives of model-written subqueries", () => {
  const subquery = (id: string, lexicalQuery: string): RetrievalSubquery => ({
    id,
    label: lexicalQuery,
    semanticQuery: `about ${lexicalQuery}`,
    lexicalQuery,
    reason: "model",
    responseLanguagePolicy: "match_user_question",
  });

  it("splits a subquery's top-level OR into one subquery per alternative, each searched on its own", () => {
    const expanded = expandLexicalAlternatives([subquery("a", "Planet plan OR Planet"), subquery("b", "Satellite plan")], 4);

    expect(expanded.map(({ id, semanticQuery, lexicalQuery }) => ({ id, semanticQuery, lexicalQuery }))).toEqual([
      { id: "subquery_1", semanticQuery: "about Planet plan OR Planet", lexicalQuery: "Planet plan" },
      { id: "subquery_2", semanticQuery: "about Planet plan OR Planet", lexicalQuery: "Planet" },
      { id: "subquery_3", semanticQuery: "about Satellite plan", lexicalQuery: "Satellite plan" },
    ]);
    expect(expanded[1]?.lexicalPlan?.options).toEqual([expect.objectContaining({ lexicalQuery: "Planet", relaxationOf: ["planet", "plan"] })]);
    expect(expanded[2]?.lexicalPlan).toBeUndefined();
  });

  it("drops relaxations before any subquery's own search when the alternatives outnumber the branches", () => {
    const expanded = expandLexicalAlternatives([
      subquery("a", "Planet plan OR Planet"),
      subquery("b", "Satellite plan OR Satellite"),
      subquery("c", "Comet plan OR Comet"),
    ], 4);

    expect(expanded.map((branch) => branch.lexicalQuery)).toEqual(["Planet plan", "Planet", "Satellite plan", "Comet plan"]);
  });

  it("folds a subquery's aliases into one search instead of dropping a later subquery when they outnumber the branches", () => {
    const expanded = expandLexicalAlternatives([
      subquery("a", "Kubernetes OR k8s"),
      subquery("b", "Helm chart"),
      subquery("c", "Ingress controller"),
      subquery("d", "Service mesh"),
    ], 4);

    expect(expanded.map(({ id, semanticQuery, lexicalQuery }) => ({ id, semanticQuery, lexicalQuery }))).toEqual([
      { id: "subquery_1", semanticQuery: "about Kubernetes OR k8s", lexicalQuery: "Kubernetes OR k8s" },
      { id: "subquery_2", semanticQuery: "about Helm chart", lexicalQuery: "Helm chart" },
      { id: "subquery_3", semanticQuery: "about Ingress controller", lexicalQuery: "Ingress controller" },
      { id: "subquery_4", semanticQuery: "about Service mesh", lexicalQuery: "Service mesh" },
    ]);
    expect(expanded[0]?.lexicalPlan?.options.map((option) => option.lexicalQuery)).toEqual(["Kubernetes", "k8s"]);
  });

  it("drops relaxations before it folds, so no folded search holds a bare name beside its phrase", () => {
    const expanded = expandLexicalAlternatives([
      subquery("a", "Kubernetes OR k8s"),
      subquery("b", "Planet plan OR Planet"),
      subquery("c", "Helm chart"),
      subquery("d", "Service mesh"),
    ], 4);

    expect(expanded.map((branch) => branch.lexicalQuery)).toEqual(["Kubernetes OR k8s", "Planet plan", "Helm chart", "Service mesh"]);
    expect(expanded.flatMap((branch) => branch.lexicalPlan?.options ?? []).some((option) => option.relaxationOf)).toBe(false);
  });
});
