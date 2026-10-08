import { describe, expect, it, vi } from "vitest";

import type { RoutineTurnEffects } from "@radioso/conversation-contract";

import { routineReplyFor } from "../../src/modules/chat/services/routines/routineReplyFor.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = {
  conversation: { id: "conversation-1" },
  agent: { id: "agent-1" },
  userMessage: { id: "message-1" },
} as unknown as PreparedSession;

const claimFor = (effects: RoutineTurnEffects, options: { streamable?: boolean } = { streamable: true }) => {
  const turn = { answer: "final text" };
  const render = vi.fn(async () => turn);
  const stream = options.streamable === false
    ? undefined
    : vi.fn(async function* (): AsyncGenerator<string, typeof turn> {
      yield "final ";
      yield "text";
      return turn;
    });
  return { claim: { effects, reply: { render, ...(stream ? { stream } : {}) } }, render, stream, turn };
};

describe("routineReplyFor", () => {
  it("hands back the claim's own stream when the turn is not durable, without rendering", async () => {
    const { claim, render, stream } = claimFor({});

    const outcome = await routineReplyFor({ session, workspaceId: "ws-1", claim });

    expect(outcome.delivery).toBe("stream");
    expect(render).not.toHaveBeenCalled();
    if (outcome.delivery !== "stream") throw new Error("expected stream delivery");
    const deltas: string[] = [];
    const generator = outcome.stream();
    let step = await generator.next();
    while (!step.done) {
      deltas.push(step.value);
      step = await generator.next();
    }
    expect(deltas).toEqual(["final ", "text"]);
    expect(step.value).toEqual({ answer: "final text" });
    expect(stream).toHaveBeenCalledOnce();
  });

  it("renders whole when the turn reports a durable effect, without touching stream", async () => {
    const { claim, render, stream } = claimFor({ terminalKind: "complete" });

    const outcome = await routineReplyFor({ session, workspaceId: "ws-1", claim });

    expect(outcome.delivery).toBe("whole");
    expect(render).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    if (outcome.delivery !== "whole") throw new Error("expected whole delivery");
    expect(outcome.turn).toEqual({ answer: "final text" });
  });

  it("renders whole when the claim has no stream, even for a non-durable turn", async () => {
    const { claim, render } = claimFor({}, { streamable: false });

    const outcome = await routineReplyFor({ session, workspaceId: "ws-1", claim });

    expect(outcome.delivery).toBe("whole");
    expect(render).toHaveBeenCalledOnce();
  });

  it("renders whole when a skill already acted outside the conversation while claiming", async () => {
    const { claim, render, stream } = claimFor({ skillsWithExternalEffects: ["crm_webhook"] });

    const outcome = await routineReplyFor({ session, workspaceId: "ws-1", claim });

    expect(outcome.delivery).toBe("whole");
    expect(render).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });

  it("renders whole when the turn hands off to a person, even though the claim can stream", async () => {
    const { claim, render, stream } = claimFor({
      terminalKind: "handoff",
      handoff: { routineId: "contact.request", stepId: "escalate", terminalKind: "handoff" },
    });

    const outcome = await routineReplyFor({ session, workspaceId: "ws-1", claim });

    expect(outcome.delivery).toBe("whole");
    expect(render).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });
});
