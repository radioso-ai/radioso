import { describe, expect, it } from "vitest";

import {
  createDirectiveAdherenceProbe,
  createDirectiveAdherenceSideChannel,
} from "../../src/shared/domain/directiveAdherence.js";
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

  it("constrains the attestation rule id to exactly the active rendered rule ids", () => {
    const fragment = createDirectiveAdherenceProbe([
      rule("d1", "be-brief"),
      rule("d2", "cite-sources"),
    ]).responseSchemaFragment();

    expect(fragment?.required).toEqual(["adherence"]);
    expect(fragment?.properties).toMatchObject({
      adherence: {
        type: "array",
        items: { additionalProperties: false, properties: { rule: { enum: ["d1", "d2"] } } },
      },
    });
  });

  it("resolves attestations to directive names and drops unknown or malformed ones", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "be-brief")]);

    const resolved = probe.resolve({
      adherence: [
        { rule: "d1", satisfied: true, note: "kept it short" },
        { rule: "ghost", satisfied: false, note: "not a rendered rule" }, // unknown id
        { rule: "d1", satisfied: "yes", note: "wrong type" },              // malformed
      ],
    });

    expect(resolved).toEqual([
      { directive: "be-brief", ruleId: "d1", satisfied: true, note: "kept it short" },
    ]);
  });

  it("returns undefined when there is no side-channel or nothing survives", () => {
    const probe = createDirectiveAdherenceProbe([rule("d1", "be-brief")]);
    expect(probe.resolve(undefined)).toBeUndefined();
    expect(probe.resolve({})).toBeUndefined();
    expect(probe.resolve({ adherence: [{ rule: "ghost", satisfied: true, note: "x" }] })).toBeUndefined();
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
    expect(channel.resolve({ adherence: [{ rule: "d1", satisfied: true, note: "kept it short" }] })).toEqual({
      directiveAdherence: [{ directive: "be-brief", ruleId: "d1", satisfied: true, note: "kept it short" }],
    });
    // Nothing to attach → no patch, so the composer adds no metadata at all.
    expect(channel.resolve(undefined)).toBeUndefined();
    expect(channel.resolve({})).toBeUndefined();
  });
});
