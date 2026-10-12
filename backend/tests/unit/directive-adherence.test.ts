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
  it("emits no schema fragment when no attestable rule ids are active", () => {
    expect(createDirectiveAdherenceProbe([]).responseSchemaFragment()).toBeNull();
    // A rule rendered without an id cannot be attested, so it contributes nothing.
    expect(createDirectiveAdherenceProbe([rule(undefined, "no-id")]).responseSchemaFragment()).toBeNull();
  });

  // The rule count has no hard cap (unconditional directives always render), so the
  // schema cannot enumerate ids without changing whenever the active set changes.
  it("emits the same schema fragment for any non-empty attestable rule set", () => {
    const fragment = createDirectiveAdherenceProbe([
      rule("d1", "be-brief"),
      rule("d2", "cite-sources"),
    ]).responseSchemaFragment();
    const otherTurn = createDirectiveAdherenceProbe([
      rule("d1", "be-brief"),
      rule("d3", "offer-callback"),
      rule("d4", "warm-tone"),
    ]).responseSchemaFragment();

    expect(JSON.stringify(otherTurn)).toBe(JSON.stringify(fragment));
    expect(fragment?.required).toEqual(["adherence"]);
    expect(fragment?.properties).toMatchObject({
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

  it("keeps the grounded answer schema byte-identical across turns with different attestable rules", () => {
    const first = buildGroundedAnswerResponseFormat(
      createDirectiveAdherenceSideChannel([rule("d1", "be-brief"), rule("d2", "cite-sources")]).schemaExtension(),
    );
    const second = buildGroundedAnswerResponseFormat(
      createDirectiveAdherenceSideChannel([rule("d2", "cite-sources")]).schemaExtension(),
    );

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
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
    expect(createDirectiveAdherenceSideChannel([]).schemaExtension()).toBeNull();
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
