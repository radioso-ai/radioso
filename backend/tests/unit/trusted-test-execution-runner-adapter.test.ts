import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { InternalAgentConfig } from "../../src/modules/agents/public.js";
import {
  TrustedTestExecutionRunnerAdapter,
} from "../../src/modules/chat/services/trustedTestExecutionRunnerAdapter.js";
import type { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import {
  exportTestExecutionReplayContinuation,
} from "../../src/modules/chat/services/testExecutionContinuation.js";
import { conversationQualityAgentConfig } from "../fixtures/conversation-quality/agent.js";

const revision: AgentRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  snapshot: {
    customInstruction: "candidate", directives: [], routines: [],
    contextVariableEnablements: [{
      id: "22222222-2222-4222-8222-222222222222", agentId: "agent-1", variableId: "variable-1",
      source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
      surfacing: "always", enabled: true, createdAt: new Date(0), updatedAt: new Date(0),
    }, {
      id: "33333333-3333-4333-8333-333333333333", agentId: "agent-1", variableId: "variable-2",
      source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
      surfacing: "on_reference", enabled: true, createdAt: new Date(0), updatedAt: new Date(0),
    }],
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

/** Drains a turn stream into the text it yielded and the result it returned. */
const collect = async <Result>(turn: AsyncGenerator<string, Result>): Promise<{ deltas: string[]; result: Result }> => {
  const deltas: string[] = [];
  let step = await turn.next();
  while (!step.done) {
    deltas.push(step.value);
    step = await turn.next();
  }
  return { deltas, result: step.value };
};

const continuation = exportTestExecutionReplayContinuation({
  routineState: null,
  pendingClarification: null,
  directiveState: { turnSeq: 1, firings: { once: { lastFiredTurn: 0, count: 1 } } },
});

describe("TrustedTestExecutionRunnerAdapter", () => {
  it("uses the selected immutable revision for an enabled assistant-first greeting", async () => {
    const bootstrap = { startConversation: vi.fn(async () => ({ answer: "Ciao!", bootstrapGreetingId: "greeting-1" })) };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: { stream: vi.fn() },
      liveAgentConfig: { find: async () => ({
        ...conversationQualityAgentConfig, name: "Marta", customInstruction: "live instruction",
        proactiveGreetingEnabled: true, assistantDefaultLocale: "it",
      }) },
      revisions: { findRevision: async () => revision },
      bootstrap: bootstrap as never,
    });

    await expect(adapter.bootstrap({ workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision, accountId: "account-1" }))
      .resolves.toEqual({ answer: "Ciao!", messageId: "greeting-1" });
    expect(bootstrap.startConversation).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1", revisionId: revision.id, sourceChannel: "authenticated_chat",
      agentOverride: expect.objectContaining({ customInstruction: "candidate", assistantDefaultLocale: "it" }),
    }));
  });

  it("uses the internal operator title when an enabled test agent has no public name", async () => {
    const bootstrap = { startConversation: vi.fn(async () => ({ answer: "Ciao!", bootstrapGreetingId: "greeting-1" })) };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: { stream: vi.fn() },
      liveAgentConfig: { find: async () => ({
        ...conversationQualityAgentConfig,
        name: "",
        internalName: "Test Chat",
        proactiveGreetingEnabled: true,
      }) },
      revisions: { findRevision: async () => revision },
      bootstrap: bootstrap as never,
    });

    await adapter.bootstrap({ workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision, accountId: "account-1" });

    expect(bootstrap.startConversation).toHaveBeenCalledWith(expect.objectContaining({
      agentOverride: expect.objectContaining({ name: "Test Chat", proactiveGreetingEnabled: true }),
    }));
  });

  it("uses the neutral display fallback when an enabled test agent has no title", async () => {
    const bootstrap = { startConversation: vi.fn(async () => ({ answer: "Ciao!", bootstrapGreetingId: "greeting-1" })) };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: { stream: vi.fn() },
      liveAgentConfig: { find: async () => ({
        ...conversationQualityAgentConfig,
        name: "",
        internalName: null,
        proactiveGreetingEnabled: true,
      }) },
      revisions: { findRevision: async () => revision },
      bootstrap: bootstrap as never,
    });

    await adapter.bootstrap({ workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision, accountId: "account-1" });

    expect(bootstrap.startConversation).toHaveBeenCalledWith(expect.objectContaining({
      agentOverride: expect.objectContaining({ name: "Assistant", proactiveGreetingEnabled: true }),
    }));
  });

  it("does not request a greeting when the private runner has no bootstrap port", async () => {
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: { stream: vi.fn() },
      liveAgentConfig: { find: vi.fn() },
      revisions: { findRevision: vi.fn() },
    });

    await expect(adapter.bootstrap({ workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision, accountId: null })).resolves.toBeNull();
  });

  it("revalidates candidate ownership and maps private history, continuation, and frozen samples into safe replay", async () => {
    const replay = {
      stream: vi.fn(async function* () {
        yield "actual ";
        yield "answer";
        return { answer: "actual answer", messageId: "ephemeral-message", continuation };
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });

    const abort = new AbortController();
    await expect(collect(adapter.stream({
      workspaceId: "ws-1",
      agentId: "agent-1",
      accountId: "account-42",
      candidateRevision: revision,
      conversationId: "private-side-1",
      message: "continue",
      history: [{ turnId: "turn-0", attemptId: "attempt-0", role: "assistant", content: "Earlier", createdAt: new Date(0) }],
      continuation,
      testValues: [{
        contextVariableId: "variable-1",
        name: "plan",
        description: "Current plan",
        value: { tier: "gold" },
        sensitive: false,
        trust: "verified",
      }, {
        contextVariableId: "variable-2",
        name: "topic",
        description: null,
        value: "billing",
        label: "Billing",
        sensitive: false,
        trust: "unverified",
      }],
      executionMode: "safe_test",
      skillEffects: "allowed",
      signal: abort.signal,
    }))).resolves.toEqual({
      deltas: ["actual ", "answer"],
      result: { answer: "actual answer", messageId: "ephemeral-message", continuation },
    });

    expect(replay.stream).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "safe_test",
      skillEffects: "allowed",
      accountId: "account-42",
      conversationId: "private-side-1",
      candidateRevision: revision,
      history: [expect.objectContaining({ conversationId: "private-side-1", content: "Earlier" })],
      directiveStateStartState: continuation.directiveState,
      // A continuation stored before routine consents (#1544) carries none.
      consentStartState: null,
      preResolvedHostVariables: [{
        name: "plan", description: "Current plan", value: { tier: "gold" }, surfacing: "always", sensitive: false, trust: "verified",
      }, {
        // A Choice sample reaches conditions by its key and label, as a stored value does live.
        name: "topic", description: null, value: "billing", label: "Billing", surfacing: "on_reference", sensitive: false, trust: "unverified",
      }],
      // Test Chat is the one caller that reads routine slot values back off the trace
      // (test_chat_turn_trace); its trace lives in agent_test_execution_attempts under
      // Test Chat's own retention, unlike eval replay, which must never request this.
      includeSlotValues: true,
      signal: abort.signal,
    }));
  });

  // #1766: the trace names the operator's messages by the ids the transcript stores them under.
  it("replays the turn's message and earlier ones under the ids the transcript stores them under", async () => {
    const replay = {
      stream: vi.fn(async function* (_input: { userMessageId?: string; history: Array<{ id: string }> }) {
        return { answer: "answer", messageId: "ephemeral-message", continuation };
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });
    const input = {
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "And on Sunday?", continuation, testValues: [],
      executionMode: "safe_test" as const, skillEffects: "suppressed" as const,
      history: [
        { turnId: "turn-1", attemptId: "attempt-1", role: "user" as const, content: "Open Saturday?", messageId: "user-message-1", createdAt: new Date(0) },
        { turnId: "turn-1", attemptId: "attempt-1", role: "assistant" as const, content: "Yes.", messageId: "answer-1", createdAt: new Date(0) },
        // A transcript stored before its messages had ids still replays.
        { turnId: "turn-0", attemptId: "attempt-0", role: "user" as const, content: "Hello", createdAt: new Date(0) },
      ],
    };

    await collect(adapter.stream({ ...input, userMessageId: "user-message-2" }));

    expect(replay.stream.mock.calls[0]?.[0].userMessageId).toBe("user-message-2");
    expect(replay.stream.mock.calls[0]?.[0].history.map((message) => message.id))
      .toEqual(["user-message-1", "answer-1", "turn-0:user:attempt-0"]);
  });

  it("replays the turn as a visitor in the operator's browser zone, and as none when the client sent no zone", async () => {
    const replay = {
      stream: vi.fn(async function* (_input: { visitorTimeZone?: string | null }) {
        return { answer: "answer", messageId: "ephemeral-message", continuation };
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });
    const input = {
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "What's on tomorrow?", history: [], continuation, testValues: [],
      executionMode: "safe_test" as const, skillEffects: "suppressed" as const,
    };

    await collect(adapter.stream({ ...input, userTimeZone: "America/Los_Angeles" }));
    await collect(adapter.stream(input));

    expect(replay.stream.mock.calls[0]?.[0]).toMatchObject({ visitorTimeZone: "America/Los_Angeles" });
    expect(replay.stream.mock.calls[1]?.[0].visitorTimeZone).toBeUndefined();
  });

  it("declares the cards Test Chat renders, returns the turn's blocks, and copies their pictures before it answers", async () => {
    const block = { type: "item_list", id: "b1", layout: "carousel", selection: "none", caption: "Flats", items: [{ key: "/0", title: "Loft", actions: [] }] };
    const toolImages = [{ imageId: "image-1", url: "https://img.homes.example/loft.jpg" }];
    const order: string[] = [];
    const replay = {
      stream: vi.fn(async function* () {
        order.push("replayed");
        return { answer: "One loft fits.", messageId: "ephemeral-message", continuation, blocks: [block], toolImages };
      }),
    };
    const recordPreview = vi.fn(async () => {
      order.push("pictures recorded");
    });
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
      toolImagePreviews: { recordPreview },
    });

    const { result } = await collect(adapter.stream({
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "Flats in Mitte?", history: [], continuation, testValues: [],
      executionMode: "safe_test", skillEffects: "suppressed",
    }));

    expect(replay.stream).toHaveBeenCalledWith(expect.objectContaining({
      clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel", "grid", "list"] } } },
    }));
    expect(result.blocks).toEqual([block]);
    expect(recordPreview).toHaveBeenCalledWith({ workspaceId: "ws-1", sources: toolImages });
    expect(order).toEqual(["replayed", "pictures recorded"]);
  });

  // #1763: a typed answer or a pick on a later turn reads the cards a reply showed from the transcript.
  it("returns what the reply's message keeps of its cards, and hands it back as that message's metadata on later turns", async () => {
    const stored = { blocks: [{ type: "item_list", id: "b1", layout: "list", selection: "single", caption: "Flats", items: [{ key: "7", title: "Loft", actions: [{ type: "select" }], fields: {} }], origin: { kind: "routine_step", skillName: "search", routineId: "r", stepId: "choose", slot: "flat" } }] };
    const replay = {
      stream: vi.fn(async function* (_input: { history: Array<{ id: string; metadata?: unknown }> }) {
        return { answer: "One loft fits.", messageId: "ephemeral-message", continuation, messageReplyBlocks: stored };
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });
    const turn = { workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision, conversationId: "private-side-1", continuation, testValues: [], executionMode: "safe_test" as const, skillEffects: "suppressed" as const };

    const { result } = await collect(adapter.stream({ ...turn, message: "Flats in Mitte?", history: [] }));
    expect(result.messageMetadata).toEqual(stored);

    await collect(adapter.stream({
      ...turn,
      message: "The first one",
      history: [
        { turnId: "turn-1", attemptId: "attempt-1", role: "user", content: "Flats in Mitte?", messageId: "user-1", createdAt: new Date(0), messageMetadata: stored },
        { turnId: "turn-1", attemptId: "attempt-1", role: "assistant", content: "One loft fits.", messageId: "answer-1", createdAt: new Date(0), messageMetadata: result.messageMetadata },
      ],
    }));
    const history = replay.stream.mock.calls.at(-1)?.[0].history ?? [];
    expect(history.map((message) => message.metadata)).toEqual([undefined, stored]);
  });

  it("classifies a turn beside its answer, shows the values on its trace, and reads them on the next turn", async () => {
    const classifiedRevision: AgentRevision = {
      ...revision,
      snapshot: {
        ...revision.snapshot,
        contextVariableEnablements: [{ ...revision.snapshot.contextVariableEnablements[1], source: "classified" }],
      },
    };
    const turnTrace = { version: 1, spine: { traceId: "trace-1", startedAt: "2026-11-22T00:00:00.000Z", stages: [] } };
    const replay = {
      stream: vi.fn(async function* () {
        yield "answer";
        return { answer: "answer", messageId: "reply-1", continuation, turnTrace };
      }),
    };
    const topic = {
      id: "variable-2", workspaceId: "ws-1", name: "topic", description: null, valueType: "enum" as const,
      options: [{ key: "billing", label: "Billing", description: null, archived: false }],
      trustTier: "unverified" as const, sensitivity: "normal" as const, defaultSurfacing: "on_reference" as const,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    const classifier = {
      classifyTranscript: vi.fn(async (input: Parameters<NonNullable<ConstructorParameters<typeof TrustedTestExecutionRunnerAdapter>[0]["classifier"]>["classifyTranscript"]>[0]) => {
        const write = await input.values.write({ conversationId: input.conversationId, variable: topic, stored: null, data: "billing", writtenBy: { kind: "classifier", ref: "context-classification/1" } });
        return { outcome: "written" as const, decisions: [{ variableId: topic.id, value: "billing", write }] };
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "stream">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => classifiedRevision },
      classifier,
    });
    const baseTurn = {
      workspaceId: "ws-1", agentId: "agent-1", accountId: "account-42", candidateRevision: classifiedRevision,
      conversationId: "private-side-1", history: [], testValues: [], executionMode: "safe_test" as const, skillEffects: "allowed" as const,
    };

    const first = await collect(adapter.stream({ ...baseTurn, message: "I was charged twice", continuation }));

    expect(classifier.classifyTranscript).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "private-side-1", variableIds: ["variable-2"],
      excerpt: { summary: null, messages: ["I was charged twice"], withheldCount: 0 },
    }));
    expect(first.result.turnTrace).toEqual({ ...turnTrace, attributes: { outcome: "written", values: [{ name: "topic", value: "billing", label: "Billing", writtenBy: "classifier" }] } });
    const carried = first.result.continuation as { contextValues?: unknown[] };
    expect(carried.contextValues).toEqual([expect.objectContaining({ contextVariableId: "variable-2", value: "billing", writtenBy: { kind: "classifier", ref: "context-classification/1" } })]);

    await collect(adapter.stream({ ...baseTurn, message: "And when is it refunded?", continuation: first.result.continuation }));

    expect(replay.stream).toHaveBeenLastCalledWith(expect.objectContaining({
      preResolvedHostVariables: [{ name: "topic", description: null, value: "billing", label: "Billing", surfacing: "on_reference", sensitive: false, trust: "unverified" }],
    }));
  });

  it("rejects corrupt and version-mismatched continuations before replay", async () => {
    const replay = { stream: vi.fn() };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });
    const input = {
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], testValues: [], executionMode: "safe_test" as const, skillEffects: "suppressed" as const,
    };

    await expect(collect(adapter.stream({ ...input, continuation: { version: 2 } }))).rejects.toThrow("test_execution_continuation_invalid");
    await expect(collect(adapter.stream({ ...input, continuation: { version: 1, routineState: "bad", pendingClarification: null, directiveState: null } })))
      .rejects.toThrow("test_execution_continuation_invalid");
    await expect(collect(adapter.stream({
      ...input,
      continuation: { version: 1, routineState: null, pendingClarification: null, directiveState: null, consents: { decisions: [{ decision: "maybe" }], prompts: [] } },
    }))).rejects.toThrow("test_execution_continuation_invalid");
    expect(replay.stream).not.toHaveBeenCalled();
  });

  it("rejects a candidate that cannot be found under the requested workspace and agent", async () => {
    const replay = { stream: vi.fn() };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => null },
    });

    await expect(collect(adapter.stream({
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], continuation: null, testValues: [], executionMode: "safe_test", skillEffects: "suppressed",
    }))).rejects.toThrow("Agent revision is unavailable for test execution");
    expect(replay.stream).not.toHaveBeenCalled();
  });

  it("does not mutate a side's persisted continuation when a replay attempt fails", async () => {
    const original = exportTestExecutionReplayContinuation({
      routineState: {
        sessionId: "private-side-1", routineId: "checkout", path: ["collect_address"], variables: { cart: "gold" }, status: "active",
      },
      pendingClarification: null,
      directiveState: null,
    });
    const replay = {
      stream: vi.fn(async function* (input: { routineStartState?: { variables: Record<string, unknown> } | null }) {
        input.routineStartState!.variables.cart = "mutated-by-failed-run";
        throw new Error("provider unavailable");
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });

    await expect(collect(adapter.stream({
      workspaceId: "ws-1", agentId: "agent-1", accountId: null, candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], continuation: original, testValues: [], executionMode: "safe_test", skillEffects: "suppressed",
    }))).rejects.toThrow("provider unavailable");
    expect(original.routineState?.variables).toEqual({ cart: "gold" });
  });
});
