import { describe, expect, it } from "vitest";

import {
  createDirectiveAdherenceProbe,
  createDirectiveAdherenceSideChannel,
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
      adherence: [{ rule: "[d1]", satisfied: true, applicable: true, note: "kept it short" }],
    })).toEqual([
      { directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "kept it short" },
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

    expect(resolved).toEqual([
      { directive: "be-brief", ruleId: "d1", satisfied: true, applicable: true, note: "kept it short" },
    ]);
  });

  it("resolves a conditional rule's unmet criteria as not applicable rather than unsatisfied", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "offer-form-on-partial")]);

    const resolved = probe.resolve({
      adherence: [
        { rule: "d1", satisfied: false, applicable: false, note: "coverage was answered, not partial" },
      ],
    });

    expect(resolved).toEqual([
      {
        directive: "offer-form-on-partial",
        ruleId: "d1",
        satisfied: false,
        applicable: false,
        note: "coverage was answered, not partial",
      },
    ]);
  });

  it("returns undefined when there is no side-channel or nothing survives", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "be-brief")]);
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
    // Nothing to attach → no patch, so the composer adds no metadata at all.
    expect(channel.resolve(undefined)).toBeUndefined();
    expect(channel.resolve({})).toBeUndefined();
  });
});
