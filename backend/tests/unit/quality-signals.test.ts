import { describe, expect, it } from "vitest";

import { SkillCatalogOutcomeSource } from "../../src/modules/quality/infra/skillCatalogOutcomeSource.js";
import { retrievalAnswerSkillDefinition, type SkillCatalogService } from "../../src/modules/skills/public.js";
import {
  QUALITY_SIGNAL_ACTIVE_TRIAGE_STATES,
  SKILL_FAILURE_STATUSES,
  resolveGroundedOutcomeTuples,
  resolveQualitySignalPredicate,
  type QualityOutcomeCatalogEntry,
} from "../../src/modules/quality/domain/qualitySignals.js";

const outcome = (name: string, groundedAnswer?: boolean) =>
  groundedAnswer === undefined ? { name } : { name, groundedAnswer };

const skill = (
  name: string,
  outcomes?: QualityOutcomeCatalogEntry["outcomes"],
): QualityOutcomeCatalogEntry => ({ name, outcomes });

describe("resolveGroundedOutcomeTuples", () => {
  it("splits catalog outcomes into grounded answers and grounding gaps", () => {
    const tuples = resolveGroundedOutcomeTuples([
      skill("retrieval.answer", [
        outcome("grounded", true),
        outcome("no_context", false),
        outcome("degraded", false),
      ]),
      skill("assistant.reply", [outcome("answered", true), outcome("unknown")]),
    ]);

    expect(tuples.grounded).toEqual([
      { skillName: "retrieval.answer", outcome: "grounded" },
      { skillName: "assistant.reply", outcome: "answered" },
    ]);
    expect(tuples.gaps).toEqual([
      { skillName: "retrieval.answer", outcome: "no_context" },
      { skillName: "retrieval.answer", outcome: "degraded" },
    ]);
  });

  it("treats an absent groundedAnswer flag as neither grounded nor a gap", () => {
    // `clarification_needed` deliberately omits the flag: asking a clarifying
    // question is not a failure to ground, and it is not a grounded answer either.
    const tuples = resolveGroundedOutcomeTuples([
      skill("retrieval.answer", [outcome("clarification_needed")]),
    ]);

    expect(tuples.grounded).toEqual([]);
    expect(tuples.gaps).toEqual([]);
  });

  it("leaves shipped non-gap retrieval outcomes out of both sides of the rate", () => {
    // Derived from the real catalog: `out_of_scope` and `unavailable` are excluded
    // because the catalog omits the flag, not because this module matches their names.
    const tuples = resolveGroundedOutcomeTuples([
      {
        name: retrievalAnswerSkillDefinition.name,
        outcomes: retrievalAnswerSkillDefinition.outcomes?.map((entry) => ({
          name: entry.name,
          ...(entry.groundedAnswer === undefined ? {} : { groundedAnswer: entry.groundedAnswer }),
        })),
      },
    ]);

    expect(tuples.grounded).toEqual([
      { skillName: "retrieval.answer", outcome: "grounded" },
      { skillName: "retrieval.answer", outcome: "grounded_degraded" },
    ]);
    expect(tuples.gaps).toEqual([{ skillName: "retrieval.answer", outcome: "no_context" }]);
  });

  it("tolerates skills with no outcomes at all", () => {
    const tuples = resolveGroundedOutcomeTuples([skill("platform.noop", []), skill("platform.other")]);
    expect(tuples).toEqual({ grounded: [], gaps: [] });
  });

});

describe("SkillCatalogOutcomeSource", () => {
  it("keeps outcomes from skills the capability policy marks forbidden", async () => {
    // A forbidden skill can still have produced turns before the capability was revoked.
    // Dropping its outcomes would shrink the grounded denominator the moment an operator
    // changes a plan, which is exactly the dishonest rate this surface exists to avoid.
    const source = new SkillCatalogOutcomeSource({
      async list() {
        return {
          skills: [
            {
              name: "retrieval.answer",
              availability: { state: "forbidden", reason: "capability_denied" },
              outcomes: [
                { name: "grounded", groundedAnswer: true },
                { name: "no_context", groundedAnswer: false },
              ],
            },
          ],
        };
      },
    } as unknown as SkillCatalogService);

    const tuples = resolveGroundedOutcomeTuples(await source.listOutcomeCatalog("workspace-1"));

    expect(tuples.grounded).toEqual([{ skillName: "retrieval.answer", outcome: "grounded" }]);
    expect(tuples.gaps).toEqual([{ skillName: "retrieval.answer", outcome: "no_context" }]);
  });

  it("carries the absent grounded flag through unchanged rather than defaulting it", async () => {
    const source = new SkillCatalogOutcomeSource({
      async list() {
        return { skills: [{ name: "retrieval.answer", outcomes: [{ name: "clarification_needed" }] }] };
      },
    } as unknown as SkillCatalogService);

    const entries = await source.listOutcomeCatalog("workspace-1");

    expect(entries[0]?.outcomes?.[0]).toEqual({ name: "clarification_needed", groundedAnswer: undefined });
    expect(resolveGroundedOutcomeTuples(entries)).toEqual({ grounded: [], gaps: [] });
  });
});

describe("resolveQualitySignalPredicate", () => {
  const tuples = resolveGroundedOutcomeTuples([
    skill("retrieval.answer", [outcome("grounded", true), outcome("no_context", false)]),
  ]);

  it("resolves negative feedback to a down-vote predicate", () => {
    expect(resolveQualitySignalPredicate("negative_feedback", tuples)).toEqual({
      kind: "feedback",
      values: ["down"],
    });
  });

  it("resolves grounding gaps to the catalog's ungrounded outcome tuples", () => {
    expect(resolveQualitySignalPredicate("grounding_gaps", tuples)).toEqual({
      kind: "actions",
      actions: [{ skillName: "retrieval.answer", outcome: "no_context" }],
    });
  });

  it("resolves skill failures to the failed skill status", () => {
    expect(resolveQualitySignalPredicate("skill_failures", tuples)).toEqual({
      kind: "skillStatuses",
      statuses: ["failed"],
    });
    expect(SKILL_FAILURE_STATUSES).toEqual(["failed"]);
  });

  it("resolves grounding gaps to an empty tuple set when the catalog marks nothing ungrounded", () => {
    const empty = resolveGroundedOutcomeTuples([skill("retrieval.answer", [outcome("grounded", true)])]);
    expect(resolveQualitySignalPredicate("grounding_gaps", empty)).toEqual({ kind: "actions", actions: [] });
  });

  it("counts only turns still in the active triage backlog", () => {
    expect(QUALITY_SIGNAL_ACTIVE_TRIAGE_STATES).toEqual(["open", "acknowledged"]);
  });
});
