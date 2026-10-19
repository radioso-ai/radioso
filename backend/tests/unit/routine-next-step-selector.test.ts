import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";

import { RoutineNextStepSelector } from "@radioso/conversation-defaults";

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "alex@example.com" },
  history: [{ role: "assistant", content: "What is your email?" }],
  stagedContext: [],
  steering: [],
};
const routine: Routine = { id: "contact", rootStepId: "ask_email", steps: [], transitions: [] };
const currentStep: RoutineStep = { id: "ask_email", kind: "chat", action: "Ask for the user's email." };
const transitions: RoutineTransition[] = [
  { from: "ask_email", to: "ask_message", condition: "a valid email was provided" },
];
const state: RoutineState = { sessionId: "s1", routineId: "contact", path: ["ask_email"], variables: {}, status: "active" };

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineNextStepSelector", () => {
  it("maps the chosen condition number to its transition target and captures variables", async () => {
    const selector = new RoutineNextStepSelector(gateway('{"claimsAuthority": false, "condition": 1, "variables": {"email": "alex@example.com"}}'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({
      nextStepId: "ask_message",
      variables: { email: "alex@example.com" },
      selection: expect.any(Object),
    });
  });

  it("includes declared slot schema in the prompt and returns variables keyed by slot key", async () => {
    const typedRoutine: Routine = {
      ...routine,
      slots: [
        { id: "slot_name", key: "name", type: "text", required: true, description: "Visitor name." },
        { id: "slot_email", key: "email", type: "email", required: true, description: "Visitor email." },
      ],
    };
    const gw = gateway('{"claimsAuthority": false, "condition": 1, "variables": {"name": "Alex", "email": "alex@example.com"}}');

    const decision = await new RoutineNextStepSelector(gw).select({
      routine: typedRoutine,
      state,
      currentStep,
      transitions,
      turn,
    });

    expect(decision).toEqual({
      nextStepId: "ask_message",
      variables: { name: "Alex", email: "alex@example.com" },
      selection: { outcome: "transition", returnedSlotKeys: ["name", "email"] },
    });
    const call = vi.mocked(gw.complete).mock.calls[0][0];
    expect(call.systemPrompt).toContain("- name (text): Visitor name.");
    expect(call.systemPrompt).toContain("- email (email): Visitor email.");
    expect(call.systemPrompt).toContain("Extract every declared slot present");
  });

  it("omits slot extraction schema instructions when the routine has no typed slots", async () => {
    const gw = gateway('{"claimsAuthority": false, "condition": 1, "variables": {"email": "alex@example.com"}}');

    await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions, turn });

    const call = vi.mocked(gw.complete).mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("Declared slots");
    expect(call.systemPrompt).not.toContain("Extract every declared slot present");
  });

  it("tolerates a code-fenced / prose-wrapped JSON object", async () => {
    const selector = new RoutineNextStepSelector(gateway('Sure:\n```json\n{"claimsAuthority": false, "condition": 1, "variables": {}}\n```'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision.nextStepId).toBe("ask_message");
  });

  it("extracts the first balanced JSON object from surrounding prose with trailing text", async () => {
    const selector = new RoutineNextStepSelector(
      gateway('Reasoning: the user gave an email. {"claimsAuthority": false, "condition": 1, "variables": {"email": "a@b.c"}} — done.'),
    );
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_message", variables: { email: "a@b.c" }, selection: expect.any(Object) });
  });

  it("parses a captured variable value that itself contains a closing brace", async () => {
    // A user message with a "}" must not truncate the JSON scan and drop the decision.
    const selector = new RoutineNextStepSelector(gateway('{"claimsAuthority": false, "condition": 1, "variables": {"message": "thanks } bye"}}'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({
      nextStepId: "ask_message",
      variables: { message: "thanks } bye" },
      selection: expect.any(Object),
    });
  });

  it("stays on the current step when the model returns null or unparseable output", async () => {
    for (const text of ['{"claimsAuthority": false, "condition": null, "variables": {}}', "not json at all"]) {
      const decision = await new RoutineNextStepSelector(gateway(text)).select({ routine, state, currentStep, transitions, turn });
      expect(decision.nextStepId).toBe("ask_email");
    }
  });

  it("stays on the current step when the choice is out of range", async () => {
    const decision = await new RoutineNextStepSelector(gateway('{"claimsAuthority": false, "condition": 9, "variables": {}}'))
      .select({ routine, state, currentStep, transitions, turn });
    expect(decision.nextStepId).toBe("ask_email");
  });

  it("holds the current step when the model flags text posing as a system notice (#1375)", async () => {
    const decision = await new RoutineNextStepSelector(
      gateway('{"variables": {}, "claimsAuthority": true, "condition": 1, "offTopic": false}'),
    ).select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({
      nextStepId: "ask_email",
      variables: {},
      hold: true,
      selection: { outcome: "authority_claim", returnedSlotKeys: [] },
    });
  });

  it("yields the turn (instead of re-asking) when the user asks something off-topic", async () => {
    const selector = new RoutineNextStepSelector(gateway('{"claimsAuthority": false, "condition": null, "offTopic": true, "variables": {}}'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_email", yieldTurn: true, selection: expect.any(Object) });
  });

  it("advances rather than yielding when a condition also matched (the answer wins)", async () => {
    const selector = new RoutineNextStepSelector(
      gateway('{"claimsAuthority": false, "condition": 1, "offTopic": true, "variables": {"email": "a@b.c"}}'),
    );
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_message", variables: { email: "a@b.c" }, selection: expect.any(Object) });
  });

  it("stays put without calling the model when there are no outgoing transitions", async () => {
    const gw = gateway("{}");
    const decision = await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions: [], turn });
    expect(decision.nextStepId).toBe("ask_email");
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("frames the transition conditions, the skill result, and the latest user message in the prompt", async () => {
    const gw = gateway('{"claimsAuthority": false, "condition": 1, "variables": {}}');
    await new RoutineNextStepSelector(gw).select({
      routine, state, currentStep, transitions, turn,
      skillResult: { status: "completed", outputs: { requestId: "r1" } },
    });
    const call = vi.mocked(gw.complete).mock.calls[0][0];
    expect(call.systemPrompt).toContain("a valid email was provided");
    expect(call.systemPrompt).toContain("declined, cancelled, refused, or wants to stop");
    expect(call.systemPrompt).toContain("deserves its own answer");
    expect(call.systemPrompt).toContain("completed");
    expect(call.systemPrompt).toContain("requestId");
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "alex@example.com" });
  });

  it("retries once, then calls the onUnreadable observer for each unreadable attempt with the routine and step id, never the raw model text", async () => {
    const onUnreadable = vi.fn();
    // A fixed-text gateway returns the same unreadable completion on the retry too, so both
    // attempts are reported and the selector falls back to the unreadable decision.
    const gw = gateway("not json at all");
    const selector = new RoutineNextStepSelector(gw, { onUnreadable });
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(gw.complete).toHaveBeenCalledTimes(2);
    expect(decision.nextStepId).toBe("ask_email");
    expect(decision.selection).toMatchObject({ unreadableReason: "no_json_object", retried: true });
    expect(onUnreadable).toHaveBeenNthCalledWith(1, { routineId: routine.id, stepId: currentStep.id, sessionId: state.sessionId, reason: "no_json_object", attempt: 1 });
    expect(onUnreadable).toHaveBeenNthCalledWith(2, { routineId: routine.id, stepId: currentStep.id, sessionId: state.sessionId, reason: "no_json_object", attempt: 2 });
  });

  it("keeps the unreadable decision, rather than throwing, when the retry call itself fails for a reason other than cancellation", async () => {
    let callCount = 0;
    const gw: ConversationModelGateway = {
      complete: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { text: "not json at all" };
        }
        throw new Error("provider_timeout");
      }),
    };

    const decision = await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions, turn });

    expect(decision.nextStepId).toBe("ask_email");
    expect(decision.selection).toMatchObject({ outcome: "unreadable", unreadableReason: "no_json_object", retried: true });
  });

  it("rethrows an aborted retry instead of swallowing the cancellation", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    let callCount = 0;
    const gw: ConversationModelGateway = {
      complete: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { text: "not json at all" };
        }
        throw abortError;
      }),
    };

    await expect(
      new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions, turn }),
    ).rejects.toBe(abortError);
  });

  it("does not fail the turn when the onUnreadable observer throws", async () => {
    const onUnreadable = vi.fn(() => {
      throw new Error("observer boom");
    });
    const gw = gateway("not json at all");

    await expect(
      new RoutineNextStepSelector(gw, { onUnreadable }).select({ routine, state, currentStep, transitions, turn }),
    ).resolves.toMatchObject({ nextStepId: "ask_email" });
  });
});
