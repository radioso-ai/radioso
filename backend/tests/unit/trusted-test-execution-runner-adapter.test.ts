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
    }],
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
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
      replay: { run: vi.fn() },
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
      replay: { run: vi.fn() },
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
      replay: { run: vi.fn() },
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
      replay: { run: vi.fn() },
      liveAgentConfig: { find: vi.fn() },
      revisions: { findRevision: vi.fn() },
    });

    await expect(adapter.bootstrap({ workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision, accountId: null })).resolves.toBeNull();
  });

  it("revalidates candidate ownership and maps private history, continuation, and frozen samples into safe replay", async () => {
    const replay = {
      run: vi.fn(async () => ({ answer: "actual answer", messageId: "ephemeral-message", continuation })),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay: replay as unknown as Pick<WorkbenchReplayRunner, "run">,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });

    await expect(adapter.run({
      workspaceId: "ws-1",
      agentId: "agent-1",
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
      }],
      executionMode: "safe_test",
    })).resolves.toEqual({ answer: "actual answer", messageId: "ephemeral-message", continuation });

    expect(replay.run).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "safe_test",
      conversationId: "private-side-1",
      candidateRevision: revision,
      history: [expect.objectContaining({ conversationId: "private-side-1", content: "Earlier" })],
      directiveStateStartState: continuation.directiveState,
      preResolvedHostVariables: [{
        name: "plan", description: "Current plan", value: { tier: "gold" }, surfacing: "always", sensitive: false, trust: "verified",
      }],
    }));
  });

  it("rejects corrupt and version-mismatched continuations before replay", async () => {
    const replay = { run: vi.fn() };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });
    const input = {
      workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], testValues: [], executionMode: "safe_test" as const,
    };

    await expect(adapter.run({ ...input, continuation: { version: 2 } })).rejects.toThrow("test_execution_continuation_invalid");
    await expect(adapter.run({ ...input, continuation: { version: 1, routineState: "bad", pendingClarification: null, directiveState: null } }))
      .rejects.toThrow("test_execution_continuation_invalid");
    expect(replay.run).not.toHaveBeenCalled();
  });

  it("rejects a candidate that cannot be found under the requested workspace and agent", async () => {
    const replay = { run: vi.fn() };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => null },
    });

    await expect(adapter.run({
      workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], continuation: null, testValues: [], executionMode: "safe_test",
    })).rejects.toThrow("Agent revision is unavailable for test execution");
    expect(replay.run).not.toHaveBeenCalled();
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
      run: vi.fn(async (input: { routineStartState?: { variables: Record<string, unknown> } | null }) => {
        input.routineStartState!.variables.cart = "mutated-by-failed-run";
        throw new Error("provider unavailable");
      }),
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => ({}) as InternalAgentConfig },
      revisions: { findRevision: async () => revision },
    });

    await expect(adapter.run({
      workspaceId: "ws-1", agentId: "agent-1", candidateRevision: revision,
      conversationId: "private-side-1", message: "continue", history: [], continuation: original, testValues: [], executionMode: "safe_test",
    })).rejects.toThrow("provider unavailable");
    expect(original.routineState?.variables).toEqual({ cart: "gold" });
  });
});
