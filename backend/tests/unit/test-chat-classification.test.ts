import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { classifyTestChatTurn, testChatAttributeInputs } from "../../src/modules/chat/services/testChatClassification.js";
import type { ContextVariable } from "../../src/modules/context-variables/public.js";
import type { ConversationClassificationService } from "../../src/modules/contextClassification/public.js";

const topic: ContextVariable = {
  id: "variable-topic",
  workspaceId: "ws-1",
  name: "topic",
  description: "What the visitor needs.",
  valueType: "enum",
  options: [
    { key: "billing", label: "Billing", description: null, archived: false },
    { key: "shipping", label: "Shipping", description: null, archived: false },
  ],
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const enablement = (variableId: string, source: "classified" | "pushed") => ({
  id: `enablement-${variableId}`, agentId: "agent-1", variableId, source, resolverSkillId: null, maxAgeSeconds: null,
  resolverTimeoutMs: null, surfacing: "on_reference" as const, enabled: true, createdAt: new Date(0), updatedAt: new Date(0),
});

const revision = (sources: Array<"classified" | "pushed">): AgentRevision => (({
  id: "revision-1",
  snapshot: {
    customInstruction: null, directives: [], routines: [],
    contextVariableEnablements: sources.map((source, index) => enablement(index === 0 ? topic.id : `variable-${index}`, source)),
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
}));

/** The real classifier's Test Chat entry, with its model answering `answer` and the values it is handed. */
const classifierAnswering = (answer: string | null) => {
  const classifyTranscript = vi.fn<ConversationClassificationService["classifyTranscript"]>(async (input) => {
    const stored = input.stored.get(topic.id) ?? null;
    const write = await input.values.write({ conversationId: input.conversationId, variable: topic, stored, data: answer, writtenBy: { kind: "classifier", ref: "context-classification/1" } });
    return { outcome: write === "written" ? "written" : "unchanged", decisions: [{ variableId: topic.id, value: answer, write }] };
  });
  return { classifyTranscript };
};

const turn = (overrides: Partial<Parameters<typeof classifyTestChatTurn>[0]> = {}) => ({
  workspaceId: "ws-1",
  agentId: "agent-1",
  conversationId: "private-side-1",
  revision: revision(["classified"]),
  history: [
    { turnId: "t0", attemptId: "a0", role: "user" as const, content: "Hello", createdAt: new Date(0) },
    { turnId: "t0", attemptId: "a0", role: "assistant" as const, content: "Hi, how can I help?", createdAt: new Date(0) },
  ],
  message: "I was charged twice",
  samples: [],
  previous: [],
  classifier: classifierAnswering("billing"),
  ...overrides,
});

describe("classifyTestChatTurn", () => {
  it("classifies the side's own messages and returns the value with who wrote it", async () => {
    const input = turn();
    const result = await classifyTestChatTurn(input);

    expect(input.classifier.classifyTranscript).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", agentId: "agent-1", conversationId: "private-side-1", variableIds: [topic.id],
      excerpt: { summary: null, messages: ["Hello", "I was charged twice"], withheldCount: 0 },
    }));
    expect(result?.values).toEqual([expect.objectContaining({
      contextVariableId: topic.id, name: "topic", value: "billing", label: "Billing", writtenBy: { kind: "classifier", ref: "context-classification/1" },
    })]);
    expect(result?.trace).toEqual({
      outcome: "written",
      values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }],
    });
  });

  it("keeps the operator's sample for a classified attribute and shows it as theirs", async () => {
    const result = await classifyTestChatTurn(turn({
      samples: [{ contextVariableId: topic.id, name: "topic", description: null, value: "shipping", label: "Shipping", sensitive: false, trust: "unverified" }],
    }));

    expect(result?.values).toEqual([]);
    expect(result?.trace.values).toEqual([{ name: "topic", value: "shipping", label: "Shipping", writtenBy: "operator" }]);
  });

  it("clears its own earlier value on null, and does nothing on a revision that classifies nothing", async () => {
    const previous = [{ contextVariableId: topic.id, name: "topic", description: null, value: "billing", label: "Billing", sensitive: false, trust: "unverified" as const, writtenBy: { kind: "classifier" as const, ref: "context-classification/1" } }];
    const cleared = await classifyTestChatTurn(turn({ previous, classifier: classifierAnswering(null) }));
    expect(cleared?.values).toEqual([]);
    expect(cleared?.trace.values).toEqual([{ name: "topic", value: null, writtenBy: null }]);

    const classifier = classifierAnswering("billing");
    await expect(classifyTestChatTurn(turn({ revision: revision(["pushed"]), classifier }))).resolves.toBeNull();
    expect(classifier.classifyTranscript).not.toHaveBeenCalled();
  });

  it("never fails the turn: a failed run keeps the values the test held", async () => {
    const previous = [{ contextVariableId: topic.id, name: "topic", description: null, value: "billing", label: "Billing", sensitive: false, trust: "unverified" as const, writtenBy: { kind: "classifier" as const, ref: "context-classification/1" } }];
    const classifier = { classifyTranscript: vi.fn(async () => { throw new Error("provider down"); }) };

    const result = await classifyTestChatTurn(turn({ previous, classifier }));

    expect(result?.values).toEqual(previous);
    expect(result?.trace).toEqual({ outcome: "failed", values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }] });
  });
});

describe("testChatAttributeInputs", () => {
  it("resolves the classifier's values under the revision's surfacing, after any sample for the same attribute", () => {
    const previous = [{ contextVariableId: topic.id, name: "topic", description: null, value: "billing", label: "Billing", sensitive: false, trust: "unverified" as const, writtenBy: { kind: "classifier" as const, ref: "context-classification/1" } }];

    expect(testChatAttributeInputs(previous, [], revision(["classified"]))).toEqual([
      { name: "topic", description: null, value: "billing", label: "Billing", surfacing: "on_reference", sensitive: false, trust: "unverified" },
    ]);
    expect(testChatAttributeInputs(previous, [{ ...previous[0], value: "shipping" }], revision(["classified"]))).toEqual([]);
  });
});
