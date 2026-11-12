import { describe, expect, it } from "vitest";

import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  type ModelToolCallRequest,
  type ModelToolCallingGateway,
} from "../../../src/shared/agent-runtime/index.js";
import { WorkspaceSetupContext } from "../../../src/modules/operatorCopilot/context/workspaceSetup.js";
import { CopilotEmptyStateService } from "../../../src/modules/operatorCopilot/services/emptyStateService.js";
import { COPILOT_EVAL_SETUP_STATES } from "../../support/copilotEvalRunner.js";
import type { CopilotEvalSetupState } from "../../support/copilotEvalSuite.js";

/**
 * What an operator is shown when Ray's panel opens, by workspace state. The model is scripted but
 * the runtime, the prompt assembly, the offer list, the validation, and the deep links are the
 * real ones, so these pin what the operator sees rather than how the pieces are wired.
 */

type ModelReply = (offers: string[]) => string;

const labelsFor = (offers: string[]): string => JSON.stringify({
  greeting: "Welcome back.",
  suggestions: offers.map((id) => ({ id, text: `Label for ${id}` })),
});

/** A model that labels exactly what it is offered, as the prompt asks, unless told to misbehave. */
const scriptedModel = (reply: ModelReply = labelsFor) => {
  const requests: ModelToolCallRequest[] = [];
  const gateway: ModelToolCallingGateway = {
    async request(request) {
      requests.push(request);
      const user = request.transcript.find((entry) => entry.role === "user");
      const offers = /Offers\.[^\n]*\n(\[.*\])/u.exec(user?.content ?? "");
      const ids = offers ? (JSON.parse(offers[1]) as Array<{ id: string }>).map((offer) => offer.id) : [];
      return { assistantMessage: reply(ids), toolCalls: [] };
    },
  };
  return { gateway, requests };
};

const emptyStateFor = (state: CopilotEvalSetupState, reply?: ModelReply) => {
  const { gateway, requests } = scriptedModel(reply);
  const service = new CopilotEmptyStateService({
    capabilityRunner: new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway }) }),
    usageLimitPolicy: { reserveAnswer: async () => ({ commit: async () => {}, release: async () => {} }) },
    prompt: "You are Ray.",
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "sunny-co" },
    setup: new WorkspaceSetupContext({ workspaceSetupState: { getSetupSignals: async () => COPILOT_EVAL_SETUP_STATES[state] } }),
  });
  return {
    requests,
    get: () => service.get({ workspaceId: "workspace-1", accountId: "account-1", permissions: new Set(["workspace.summary.read"]), locale: "en" }),
  };
};

describe("Ray's empty panel by workspace state", () => {
  it("fresh workspace, setup open: the next steps as links, and nothing that says anything has happened", async () => {
    const { get, requests } = emptyStateFor("fresh");
    const state = await get();

    expect(state.phase).toBe("setup");
    expect(state.firstConversationHappened).toBe(false);
    expect(state.suggestions).toEqual([
      { kind: "setup_step", step: "documents", text: "Label for documents", href: "/w/sunny-co/knowledge" },
      { kind: "setup_step", step: "conversation", text: "Label for conversation", href: "/w/sunny-co/agents" },
      { kind: "setup_step", step: "directives_or_routines", text: "Label for directives_or_routines", href: "/w/sunny-co/agents?tab=behavior&anchor=assistant-directives" },
    ]);
    // The model was told the same facts the response states.
    expect(requests[0].systemPrompt).toContain('"firstConversationHappened":false');
    expect(requests[0].systemPrompt).toContain('"phase":"setup"');
  });

  it("fresh workspace, takeover closed before any conversation: the open-ended tail, and still no claim that anything has happened", async () => {
    const { get, requests } = emptyStateFor("dismissed_before_first_conversation");
    const state = await get();

    expect(state.phase).toBe("open");
    expect(state.firstConversationHappened).toBe(false);
    expect(state.suggestions.map((suggestion) => suggestion.kind)).toEqual(["prompt", "prompt", "prompt"]);
    expect(state.suggestions.map((suggestion) => "intent" in suggestion ? suggestion.intent : null)).toEqual(["crawl_more", "tighten_tone", "draft_routine"]);
    // Setup is over for Ray's purposes, but it is still told no conversation exists.
    expect(requests[0].systemPrompt).toContain('"firstConversationHappened":false');
  });

  it("partly set up: only the steps still open, and the conversation that already happened is reported", async () => {
    const { get } = emptyStateFor("partly_set_up");
    const state = await get();

    expect(state.phase).toBe("setup");
    expect(state.firstConversationHappened).toBe(true);
    expect(state.suggestions.map((suggestion) => "step" in suggestion ? suggestion.step : null)).toEqual(["directives_or_routines", "notify_destination", "credential"]);
    expect(state.suggestions.map((suggestion) => "step" in suggestion ? suggestion.step : null)).not.toContain("documents");
    expect(state.suggestions.map((suggestion) => "step" in suggestion ? suggestion.step : null)).not.toContain("conversation");
  });

  it("complete: the open-ended tail, with no setup step offered and no setup context sent to the model", async () => {
    const { get, requests } = emptyStateFor("complete");
    const state = await get();

    expect(state.phase).toBe("open");
    expect(state.firstConversationHappened).toBe(true);
    expect(state.suggestions.map((suggestion) => "intent" in suggestion ? suggestion.intent : null)).toEqual(["crawl_more", "tighten_tone", "draft_routine"]);
    expect(requests[0].systemPrompt).not.toContain('"workspace_setup"');
  });

  it.each(["fresh", "dismissed_before_first_conversation", "partly_set_up", "complete"] as const)(
    "%s: a malformed reply leaves a neutral panel that still reports the state",
    async (name) => {
      const expected = emptyStateFor(name);
      const reference = await expected.get();
      const { get } = emptyStateFor(name, () => "I could not write that, sorry.");
      expect(await get()).toEqual({ phase: reference.phase, firstConversationHappened: reference.firstConversationHappened, greeting: null, suggestions: [] });
    },
  );

  it.each(["fresh", "dismissed_before_first_conversation", "partly_set_up", "complete"] as const)(
    "%s: a reply that labels only some of what was offered is unusable, not shown in part",
    async (name) => {
      const { get } = emptyStateFor(name, (offers) => labelsFor(offers.slice(0, 1)));
      const state = await get();
      expect(state.greeting).toBeNull();
      expect(state.suggestions).toEqual([]);
    },
  );

  it("never shows a step the model labels that was not offered", async () => {
    const { get } = emptyStateFor("partly_set_up", (offers) => labelsFor([...offers, "documents", "conversation", "invented_step"]));
    const state = await get();
    expect(state.suggestions).toHaveLength(3);
    expect(state.suggestions.map((suggestion) => "step" in suggestion ? suggestion.step : null)).not.toContain("documents");
  });
});
