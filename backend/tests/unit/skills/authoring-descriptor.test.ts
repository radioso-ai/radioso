import { describe, expect, it } from "vitest";

import {
  externalSkillToAuthoringDescriptor,
  skillCatalogEntryToAuthoringDescriptor,
  type SkillCatalogDescriptorSource,
} from "../../../src/modules/skills/authoringDescriptor.js";

const retrievalLike: SkillCatalogDescriptorSource = {
  name: "retrieval.answer",
  displayName: "Grounded answer",
  description: "Answer a question from indexed documents.",
  owner: "retrieval",
  intake: {
    enabled: true,
    supportedCallers: ["assistant"],
    intent: { description: "ask a question", examples: [] },
    fields: [
      {
        name: "query",
        displayName: "query",
        type: "string",
        required: true,
        maxLength: 8000,
        extractionHint: "the user's question",
      },
    ],
    confirmation: "none",
    interruptionPolicy: "cancel_on_topic_change",
  },
  outcomes: [
    { name: "grounded", displayName: "Grounded answer", status: "completed", groundedAnswer: true },
    { name: "no_context", displayName: "No context", status: "failed" },
  ],
};

describe("skillCatalogEntryToAuthoringDescriptor", () => {
  it("normalizes intake fields and outcomes into the authoring descriptor", () => {
    const descriptor = skillCatalogEntryToAuthoringDescriptor(retrievalLike);

    expect(descriptor.skillName).toBe("retrieval.answer");
    expect(descriptor.displayName).toBe("Grounded answer");
    expect(descriptor.category).toBe("retrieval");
    expect(descriptor.description).toBe("Answer a question from indexed documents.");
    expect(descriptor.inputs).toEqual([
      { key: "query", type: "text", required: true, description: "the user's question" },
    ]);
    expect(descriptor.outcomes).toEqual([
      { name: "grounded", displayName: "Grounded answer", status: "completed" },
      { name: "no_context", displayName: "No context", status: "failed" },
    ]);
  });

  it("maps the intake `string` type onto the routine `text` vocabulary", () => {
    const descriptor = skillCatalogEntryToAuthoringDescriptor(retrievalLike);
    expect(descriptor.inputs[0].type).toBe("text");
  });

  it("preserves enum values and the enum/phone/number/date/email types verbatim", () => {
    const descriptor = skillCatalogEntryToAuthoringDescriptor({
      name: "demo.skill",
      displayName: "Demo",
      description: "",
      owner: "platform",
      intake: {
        enabled: true,
        supportedCallers: ["assistant"],
        intent: { description: "", examples: [] },
        fields: [
          { name: "tier", displayName: "Tier", type: "enum", required: false, enumValues: ["a", "b"] },
          { name: "phone", displayName: "Phone", type: "phone", required: true },
          { name: "count", displayName: "Count", type: "number", required: false },
          { name: "when", displayName: "When", type: "date", required: false },
          { name: "addr", displayName: "Address", type: "email", required: true },
        ],
        confirmation: "none",
        interruptionPolicy: "cancel_on_topic_change",
      },
      outcomes: [],
    });

    expect(descriptor.inputs).toEqual([
      { key: "tier", type: "enum", required: false, enumValues: ["a", "b"] },
      { key: "phone", type: "phone", required: true },
      { key: "count", type: "number", required: false },
      { key: "when", type: "date", required: false },
      { key: "addr", type: "email", required: true },
    ]);
  });

  it("yields empty inputs for a skill with no intake (e.g. customer_email.skill)", () => {
    const descriptor = skillCatalogEntryToAuthoringDescriptor({
      name: "customer_email.skill",
      displayName: "Customer email skill",
      description: "Send customer email.",
      owner: "platform",
      outcomes: [
        { name: "sent", displayName: "Sent", status: "completed" },
        { name: "failed", displayName: "Failed", status: "failed" },
      ],
    });

    expect(descriptor.inputs).toEqual([]);
    expect(descriptor.outcomes.map((o) => o.name)).toEqual(["sent", "failed"]);
  });

  it("reports no data outputs (catalog entries expose outcomes, not a data output schema)", () => {
    const descriptor = skillCatalogEntryToAuthoringDescriptor(retrievalLike);
    expect(descriptor.hasDataOutputs).toBe(false);
  });
});

describe("externalSkillToAuthoringDescriptor", () => {
  it("projects exposed params only and defaults unknown MCP param metadata conservatively", () => {
    const descriptor = externalSkillToAuthoringDescriptor({
      skillName: "post_slack",
      displayName: "Post Slack",
      description: "Post a message to Slack.",
      exposedParams: {
        message: { description: "Message body." },
        thread: {},
      },
      declaredOutcomes: ["sent", "failed"],
    });

    expect(descriptor).toMatchObject({
      skillName: "post_slack",
      displayName: "Post Slack",
      category: "external_mcp",
      description: "Post a message to Slack.",
      inputs: [
        { key: "message", type: "text", required: false, description: "Message body." },
        { key: "thread", type: "text", required: false },
      ],
      outcomes: [
        { name: "sent", displayName: "sent", status: "completed" },
        { name: "failed", displayName: "failed", status: "failed" },
      ],
      hasDataOutputs: false,
    });
  });

  it("treats outcomeMap values as outcome names and deduplicates them with declared outcomes", () => {
    const descriptor = externalSkillToAuthoringDescriptor({
      skillName: "crm_lookup",
      exposedParams: {},
      declaredOutcomes: ["found"],
      outcomeMap: {
        ok: "found",
        empty: "not_found",
        provider_failed: "failed",
      },
    });

    expect(descriptor.displayName).toBe("crm_lookup");
    expect(descriptor.outcomes).toEqual([
      { name: "found", displayName: "found", status: "completed" },
      { name: "not_found", displayName: "not_found", status: "completed" },
      { name: "failed", displayName: "failed", status: "failed" },
    ]);
  });

  it("falls back to coarse completed and failed outcomes when none are declared", () => {
    const descriptor = externalSkillToAuthoringDescriptor({
      skillName: "bare_tool",
      exposedParams: {},
    });

    expect(descriptor.outcomes).toEqual([
      { name: "completed", displayName: "completed", status: "completed" },
      { name: "failed", displayName: "failed", status: "failed" },
    ]);
  });
});
