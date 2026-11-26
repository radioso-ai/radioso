import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { classifyTestChatTurn, testChatAttributeInputs } from "../../src/modules/chat/services/testChatClassification.js";
import type { ContextVariable } from "../../src/modules/context-variables/public.js";

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

const urgency: ContextVariable = {
  ...topic,
  id: "variable-urgency",
  name: "urgency",
  options: [{ key: "urgent", label: "Urgent", description: null, archived: false }],
};

type TestChatClassifier = Parameters<typeof classifyTestChatTurn>[0]["classifier"];

/** The real classifier's Test Chat entry, with its model answering `answer` for the topic and the values it is handed. */
const classifierAnswering = (answer: string | null, definitions: ContextVariable[] = [topic]) => {
  const classifyTranscript = vi.fn<TestChatClassifier["classifyTranscript"]>(async (input) => {
    const stored = input.stored.get(topic.id) ?? null;
    const write = await input.values.write({ conversationId: input.conversationId, variable: topic, stored, data: answer, writtenBy: { kind: "classifier", ref: "context-classification/1" } });
    return { outcome: write === "written" ? "written" : "unchanged", decisions: [{ variableId: topic.id, value: answer, write }] };
  });
  const readDefinitions = vi.fn<TestChatClassifier["readDefinitions"]>(async () => definitions);
  return { classifyTranscript, readDefinitions };
};

const earlier = [{ contextVariableId: topic.id, name: "topic", description: null, value: "billing", label: "Billing", sensitive: false, trust: "unverified" as const, writtenBy: { kind: "classifier" as const, ref: "context-classification/1" } }];

const turn = (overrides: Partial<Parameters<typeof classifyTestChatTurn>[0]> = {}): Parameters<typeof classifyTestChatTurn>[0] => ({
  workspaceId: "ws-1",
  agentId: "agent-1",
  conversationId: "private-side-1",
  attemptId: "attempt-1",
  revision: revision(["classified"]),
  history: [
    { turnId: "t0", attemptId: "a0", role: "user" as const, content: "Hello", messageId: "m0", createdAt: new Date(0) },
    { turnId: "t0", attemptId: "a0", role: "assistant" as const, content: "Hi, how can I help?", createdAt: new Date(0) },
  ],
  message: "I was charged twice",
  userMessageId: "m1",
  samples: [],
  previous: { values: [], withheldMessageIds: [] },
  sensitiveSlotKeys: [],
  classifier: classifierAnswering("billing"),
  ...overrides,
});

describe("classifyTestChatTurn", () => {
  it("classifies the side's own messages and returns the value with who wrote it", async () => {
    const input = turn();
    const result = await classifyTestChatTurn(input);

    expect(input.classifier.classifyTranscript).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", agentId: "agent-1", conversationId: "private-side-1", variables: [topic],
      excerpt: { summary: null, messages: ["Hello", "I was charged twice"], withheldCount: 0 },
    }));
    expect(result?.state.values).toEqual([expect.objectContaining({
      contextVariableId: topic.id, name: "topic", value: "billing", label: "Billing", writtenBy: { kind: "classifier", ref: "context-classification/1" },
    })]);
    expect(result?.trace).toEqual({
      outcome: "written",
      values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }],
    });
  });

  it("lists every attribute the revision classifies, unset ones as null with no writer", async () => {
    const twoClassified: AgentRevision = {
      ...revision(["classified"]),
      snapshot: { ...revision(["classified"]).snapshot, contextVariableEnablements: [enablement(topic.id, "classified"), enablement(urgency.id, "classified")] },
    };

    const result = await classifyTestChatTurn(turn({ revision: twoClassified, classifier: classifierAnswering("billing", [topic, urgency]) }));

    expect(result?.trace.values).toEqual([
      { name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" },
      { name: "urgency", value: null, writtenBy: null },
    ]);
  });

  it("keeps the operator's sample for a classified attribute and shows it as theirs", async () => {
    const result = await classifyTestChatTurn(turn({
      samples: [{ contextVariableId: topic.id, name: "topic", description: null, value: "shipping", label: "Shipping", sensitive: false, trust: "unverified" }],
    }));

    expect(result?.state.values).toEqual([]);
    expect(result?.trace.values).toEqual([{ name: "topic", value: "shipping", label: "Shipping", writtenBy: "operator" }]);
  });

  it("clears its own earlier value on null, and does nothing on a revision that classifies nothing", async () => {
    const cleared = await classifyTestChatTurn(turn({ previous: { values: earlier, withheldMessageIds: [] }, classifier: classifierAnswering(null) }));
    expect(cleared?.state.values).toEqual([]);
    expect(cleared?.trace.values).toEqual([{ name: "topic", value: null, writtenBy: null }]);

    const classifier = classifierAnswering("billing");
    await expect(classifyTestChatTurn(turn({ revision: revision(["pushed"]), classifier }))).resolves.toBeNull();
    expect(classifier.classifyTranscript).not.toHaveBeenCalled();
  });

  it("does not classify a turn whose routine held a sensitive slot, and withholds its message from every later run", async () => {
    const classifier = classifierAnswering("shipping");
    const sensitive = await classifyTestChatTurn(turn({
      message: "My card number is 4242 4242 4242 4242",
      previous: { values: earlier, withheldMessageIds: [] },
      sensitiveSlotKeys: ["card_number"],
      classifier,
    }));

    expect(classifier.classifyTranscript).not.toHaveBeenCalled();
    expect(sensitive?.state).toEqual({ values: earlier, withheldMessageIds: ["m1"] });
    expect(sensitive?.trace).toEqual({ outcome: "skipped_sensitive", values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }] });

    const next = turn({
      history: [
        ...turn().history,
        { turnId: "t1", attemptId: "a1", role: "user" as const, content: "My card number is 4242 4242 4242 4242", messageId: "m1", createdAt: new Date(0) },
        { turnId: "t1", attemptId: "a1", role: "assistant" as const, content: "Thanks.", createdAt: new Date(0) },
      ],
      message: "When does it arrive?",
      userMessageId: "m2",
      previous: sensitive!.state,
      classifier,
    });
    await classifyTestChatTurn(next);
    expect(classifier.classifyTranscript).toHaveBeenCalledWith(expect.objectContaining({
      excerpt: { summary: null, messages: ["Hello", "When does it arrive?"], withheldCount: 1 },
    }));
  });

  it("never fails the turn: a failed run keeps the values the test held", async () => {
    const classifier = { readDefinitions: vi.fn(async () => [topic]), classifyTranscript: vi.fn(async () => { throw new Error("provider down"); }) };

    const result = await classifyTestChatTurn(turn({ previous: { values: earlier, withheldMessageIds: [] }, classifier }));

    expect(result?.state.values).toEqual(earlier);
    expect(result?.trace).toEqual({ outcome: "failed", values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }] });
  });

  it("gives up at its bound when the model never answers, aborts the call, and keeps the values the test held", async () => {
    let signal: AbortSignal | undefined;
    const classifier = {
      readDefinitions: vi.fn(async () => [topic]),
      // A provider that ignores the abort: only the bound ends the wait.
      classifyTranscript: vi.fn((input: { signal?: AbortSignal }) => {
        signal = input.signal;
        return new Promise<never>(() => undefined);
      }),
    };
    const startedAt = Date.now();

    const result = await classifyTestChatTurn(turn({ previous: { values: earlier, withheldMessageIds: [] }, classifier: classifier, timeoutMs: 30 }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
    expect(result?.state.values).toEqual(earlier);
    expect(result?.trace.outcome).toBe("skipped_timeout");
  });

  it("aborts the call when the turn itself is cancelled", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const classifier = {
      readDefinitions: vi.fn(async () => [topic]),
      classifyTranscript: vi.fn((input: { signal?: AbortSignal }) => {
        signal = input.signal;
        return new Promise<never>((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }),
    };

    const pending = classifyTestChatTurn(turn({ classifier: classifier, signal: controller.signal }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ trace: { outcome: "failed" } });
    expect(signal?.aborted).toBe(true);
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
