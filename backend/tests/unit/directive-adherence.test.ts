import { describe, expect, it } from "vitest";

import {
  createDirectiveAdherenceProbe,
  createDirectiveAdherenceSideChannel,
  directiveAdherenceMetadataOf,
  unmetDirectiveNames,
  type DirectiveAdherenceTally,
} from "../../src/shared/domain/directiveAdherence.js";
import { buildGroundedAnswerResponseFormat } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import type { SteeringRule } from "@radioso/conversation-contract";

const rule = (id: string | undefined, directiveName: string): SteeringRule => ({
  ...(id ? { id } : {}),
  directiveName,
  action: `${directiveName} action`,
  source: "directive",
  lifespan: "response",
});

describe("createDirectiveAdherenceProbe", () => {
  // The rule count has no hard cap (unconditional directives always render), and a
  // turn with none still owes the model the same field, so the schema cannot
  // enumerate ids or omit the field without changing whenever the active set does.
  it("emits the same schema fragment whatever the attestable rule set, including none", () => {
    const empty = createDirectiveAdherenceProbe([]).responseSchemaFragment();
    // A rule rendered without an id cannot be attested, so it contributes nothing
    // more than an empty rule set would.
    const noIds = createDirectiveAdherenceProbe([rule(undefined, "no-id")]).responseSchemaFragment();
    const fragment = createDirectiveAdherenceProbe([
      rule("d1", "be-brief"),
      rule("d2", "cite-sources"),
    ]).responseSchemaFragment();
    const otherTurn = createDirectiveAdherenceProbe([
      rule("d1", "be-brief"),
      rule("d3", "offer-callback"),
      rule("d4", "warm-tone"),
    ]).responseSchemaFragment();

    expect(JSON.stringify(empty)).toBe(JSON.stringify(fragment));
    expect(JSON.stringify(noIds)).toBe(JSON.stringify(fragment));
    expect(JSON.stringify(otherTurn)).toBe(JSON.stringify(fragment));
    expect(fragment.required).toEqual(["adherence"]);
    expect(fragment.beforeAnswer?.required).toEqual(["adherencePlan"]);
    expect(fragment.beforeAnswer?.properties).toMatchObject({
      adherencePlan: {
        type: "array",
        items: {
          additionalProperties: false,
          required: ["rule", "commitment"],
          properties: { rule: { type: "string" }, commitment: { type: "string" } },
        },
      },
    });
    expect(fragment.properties).toMatchObject({
      adherence: {
        type: "array",
        items: {
          additionalProperties: false,
          required: ["rule", "satisfied", "applicable", "note"],
          properties: { rule: { type: "string" } },
        },
      },
    });
  });

  it("keeps the grounded answer schema byte-identical across turns with different attestable rules, including zero", () => {
    const withTwoRules = buildGroundedAnswerResponseFormat(
      createDirectiveAdherenceSideChannel([rule("d1", "be-brief"), rule("d2", "cite-sources")]).schemaExtension(),
    );
    const withOneRule = buildGroundedAnswerResponseFormat(
      createDirectiveAdherenceSideChannel([rule("d2", "cite-sources")]).schemaExtension(),
    );
    const withNoRules = buildGroundedAnswerResponseFormat(
      createDirectiveAdherenceSideChannel([]).schemaExtension(),
    );

    expect(JSON.stringify(withOneRule)).toBe(JSON.stringify(withTwoRules));
    expect(JSON.stringify(withNoRules)).toBe(JSON.stringify(withTwoRules));
  });

  it("accepts a rendered rule id the model wrote with its surrounding brackets", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "be-brief")]);

    expect(probe.resolve({
      adherencePlan: [{ rule: "[d1]", commitment: "two sentences at most" }],
      adherence: [{ rule: "[d1]", satisfied: true, applicable: true, note: "kept it short" }],
    })?.entries).toEqual([
      {
        directive: "be-brief",
        ruleId: "d1",
        commitment: "two sentences at most",
        satisfied: true,
        applicable: true,
        note: "kept it short",
      },
    ]);
  });

  it("resolves attestations to directive names and drops unknown or malformed ones", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "be-brief")]);

    const resolved = probe.resolve({
      adherence: [
        { rule: "d1", satisfied: true, applicable: true, note: "kept it short" },
        { rule: "ghost", satisfied: false, applicable: true, note: "not a rendered rule" }, // unknown id
        { rule: "d1", satisfied: "yes", applicable: true, note: "wrong type" },              // malformed
        { rule: "d1", satisfied: true, note: "missing applicable" },                         // malformed
      ],
    });

    expect(resolved).toEqual({
      entries: [{ directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "kept it short" }],
      ungraded: [],
      ungradedRuleCount: 0,
    });
  });

  it("resolves a conditional rule's unmet criteria as not applicable rather than unsatisfied", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "offer-form-on-partial")]);

    const resolved = probe.resolve({
      adherence: [
        { rule: "d1", satisfied: false, applicable: false, note: "coverage was answered, not partial" },
      ],
    });

    expect(resolved?.entries).toEqual([
      {
        directive: "offer-form-on-partial",
        ruleId: "d1",
        satisfied: false,
        applicable: false,
        note: "coverage was answered, not partial",
      },
    ]);
  });

  // #1575: the answer commits to each rule before it writes (`adherencePlan`, ahead of
  // `answer`), then grades itself after. Both resolve onto the same per-rule entry.
  it("attaches each rule's pre-answer commitment to its grade, and drops a commitment to an unrendered rule", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "prices-from-the-course-page"), rule("d2", "be-brief")]);

    const resolved = probe.resolve({
      adherencePlan: [
        { rule: "d1", commitment: "  leave out every figure;\n point to the course page " },
        { rule: "ghost", commitment: "not a rendered rule" },
        { rule: "d2", commitment: "" },
      ],
      adherence: [
        { rule: "d1", satisfied: true, applicable: true, note: "no figures given" },
        { rule: "d2", satisfied: true, applicable: true, note: "short" },
      ],
    });

    expect(resolved?.entries).toEqual([
      {
        directive: "prices-from-the-course-page",
        ruleId: "d1",
        commitment: "leave out every figure; point to the course page",
        satisfied: true,
        applicable: true,
        note: "no figures given",
      },
      // An empty commitment is no commitment, so the entry carries none.
      { directive: "be-brief", ruleId: "d2", satisfied: true, applicable: true, note: "short" },
    ]);
  });

  // #1575 review: the plan is bounded the way the envelope bounds `requestFocus`, with limits
  // that are part of the turn-invariant schema.
  it("bounds the plan's length and each commitment's length, and truncates a longer commitment on read", () => {
    const fragment = createDirectiveAdherenceProbe([]).responseSchemaFragment();
    const plan = fragment.beforeAnswer?.properties.adherencePlan as {
      maxItems?: number;
      items: { properties: { commitment: { maxLength?: number } } };
    };
    const maxLength = plan.items.properties.commitment.maxLength;

    expect(plan.maxItems).toEqual(expect.any(Number));
    expect(maxLength).toEqual(expect.any(Number));
    const long = "leave out every figure ".repeat(200);
    const resolved = createDirectiveAdherenceProbe([rule("d1", "prices")]).resolve({
      adherencePlan: [{ rule: "d1", commitment: long }],
      adherence: [{ rule: "d1", satisfied: true, applicable: true, note: "no figures" }],
    });
    expect(resolved?.entries[0]?.commitment).toBe(long.replace(/\s+/g, " ").trim().slice(0, maxLength));
  });

  it("names every rendered rule the answer returned no grade for, whatever else it returned", () => {
    const probe = createDirectiveAdherenceProbe([
      rule("d1", "inline-supported-links"),
      rule("d2", "represent-organization"),
      rule("d3", "prices-from-the-course-page"),
      rule(undefined, "not-attestable"),
    ]);

    expect(probe.resolve({
      adherencePlan: [{ rule: "d3", commitment: "leave out every figure" }],
      adherence: [
        { rule: "d1", satisfied: false, applicable: true, note: "no link" },
        { rule: "d1", satisfied: true, applicable: true, note: "a second grade for the same rule" },
        { rule: "d3", satisfied: "yes", applicable: true, note: "malformed" },
      ],
    })).toEqual({
      // One grade per rule: the first one counts.
      entries: [{ directive: "inline-supported-links", ruleId: "d1", satisfied: false, applicable: true, note: "no link" }],
      // A commitment without a grade still leaves the rule ungraded.
      ungraded: ["represent-organization", "prices-from-the-course-page"],
      ungradedRuleCount: 2,
    });
    // A reply that carried no grades at all leaves every rendered rule ungraded.
    expect(probe.resolve(undefined)).toEqual({
      entries: [],
      ungraded: ["inline-supported-links", "represent-organization", "prices-from-the-course-page"],
      ungradedRuleCount: 3,
    });
  });

  it("returns undefined when no attestable rule was rendered, whatever the model returned", () => {
    const probe = createDirectiveAdherenceProbe([rule(undefined, "no-id")]);
    expect(probe.resolve(undefined)).toBeUndefined();
    expect(probe.resolve({})).toBeUndefined();
    expect(probe.resolve({ adherence: [{ rule: "ghost", satisfied: true, applicable: true, note: "x" }] })).toBeUndefined();
  });
});

describe("createDirectiveAdherenceSideChannel", () => {
  it("exposes the probe's schema fragment through the capability-neutral port", () => {
    const channel = createDirectiveAdherenceSideChannel([rule("d1", "be-brief")]);
    expect(channel.schemaExtension()).toEqual(
      createDirectiveAdherenceProbe([rule("d1", "be-brief")]).responseSchemaFragment(),
    );
    // Still a schema fragment, not null, with no active rules: the answer schema's
    // shape must not depend on this turn's steering.
    expect(createDirectiveAdherenceSideChannel([]).schemaExtension()).toEqual(
      createDirectiveAdherenceProbe([]).responseSchemaFragment(),
    );
  });

  it("wraps resolved attestations in an opaque directiveAdherence metadata patch", () => {
    const channel = createDirectiveAdherenceSideChannel([rule("d1", "be-brief")]);
    expect(channel.resolve({ adherence: [{ rule: "d1", satisfied: true, applicable: true, note: "kept it short" }] })).toEqual({
      directiveAdherence: [{ directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "kept it short" }],
    });
    // Nothing rendered → nothing to attach, so the composer adds no metadata at all.
    const nothingRendered = createDirectiveAdherenceSideChannel([]);
    expect(nothingRendered.resolve(undefined)).toBeUndefined();
    expect(nothingRendered.resolve({})).toBeUndefined();
  });

  it("names the rendered rules left ungraded in the patch, beside the grades that did arrive", () => {
    const channel = createDirectiveAdherenceSideChannel([rule("d1", "be-brief"), rule("d2", "cite-sources")]);

    expect(channel.resolve({ adherence: [{ rule: "d1", satisfied: true, applicable: true, note: "short" }] })).toEqual({
      directiveAdherence: [{ directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "short" }],
      ungradedDirectives: ["cite-sources"],
    });
    expect(channel.resolve(undefined)).toEqual({ ungradedDirectives: ["be-brief", "cite-sources"] });
  });

  it("reports one tally of verdict counts per resolved answer, and none when nothing was rendered", () => {
    const tallies: DirectiveAdherenceTally[] = [];
    const channel = createDirectiveAdherenceSideChannel(
      [rule("d1", "be-brief"), rule("d2", "cite-sources"), rule("d3", "offer-form-on-partial"), rule("d4", "warm-tone")],
      { onTally: (tally) => tallies.push(tally) },
    );

    channel.resolve({
      adherence: [
        { rule: "d1", satisfied: true, applicable: true, note: "short" },
        { rule: "d2", satisfied: false, applicable: true, note: "no citation" },
        { rule: "d3", satisfied: false, applicable: false, note: "coverage was answered" },
      ],
    });
    createDirectiveAdherenceSideChannel([], { onTally: (tally) => tallies.push(tally) }).resolve({});

    expect(tallies).toEqual([{ satisfied: 1, unsatisfied: 1, notApplicable: 1, ungraded: 1 }]);
  });

  // #1575 review: every verdict counts rendered rules. A directive rendered as two rules is
  // counted twice, and listed as not graded only when neither rule got a grade.
  it("counts ungraded rules per rule, and lists a directive as not graded only when none of its rules was graded", () => {
    const tallies: DirectiveAdherenceTally[] = [];
    const channel = createDirectiveAdherenceSideChannel(
      [rule("d1", "split-rule"), rule("d2", "split-rule"), rule("d3", "never-graded"), rule("d4", "never-graded")],
      { onTally: (tally) => tallies.push(tally) },
    );

    expect(channel.resolve({ adherence: [{ rule: "d1", satisfied: true, applicable: true, note: "kept" }] })).toEqual({
      directiveAdherence: [{ directive: "split-rule", ruleId: "d1", satisfied: true, applicable: true, note: "kept" }],
      ungradedDirectives: ["never-graded"],
    });
    expect(tallies).toEqual([{ satisfied: 1, unsatisfied: 0, notApplicable: 0, ungraded: 3 }]);
  });
});

describe("unmetDirectiveNames", () => {
  it("names each directive graded applicable and unsatisfied once, never a not-applicable one", () => {
    expect(unmetDirectiveNames([
      { directive: "prices-from-the-course-page", ruleId: "d1", satisfied: false, applicable: true, note: "quoted prices" },
      { directive: "offer-form-on-partial", ruleId: "d2", satisfied: false, applicable: false, note: "answered" },
      { directive: "be-brief", ruleId: "d3", satisfied: true, applicable: true, note: "short" },
      { directive: "prices-from-the-course-page", ruleId: "d4", satisfied: false, applicable: true, note: "again" },
    ])).toEqual(["prices-from-the-course-page"]);
    expect(unmetDirectiveNames([])).toEqual([]);
  });
});

describe("directiveAdherenceMetadataOf", () => {
  it("picks the adherence keys out of a presentation's metadata and nothing else", () => {
    const directiveAdherence = [{ directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "short" }];

    expect(directiveAdherenceMetadataOf({
      directiveAdherence,
      ungradedDirectives: ["cite-sources"],
      skillName: "retrieval.answer",
    })).toEqual({ directiveAdherence, ungradedDirectives: ["cite-sources"] });
    expect(directiveAdherenceMetadataOf({ directiveAdherence })).toEqual({ directiveAdherence });
    expect(directiveAdherenceMetadataOf({ skillName: "retrieval.answer" })).toEqual({});
    expect(directiveAdherenceMetadataOf(undefined)).toEqual({});
  });
});
