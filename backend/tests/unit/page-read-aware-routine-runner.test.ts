import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineResumeInput,
  ConversationRoutineRunner,
  PendingRenderableTurn,
  RenderableTurn,
  Routine,
  RoutineState,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { pageReadRecordOf } from "../../src/modules/chat/services/pageRead/pageReadSessionOutcome.js";
import {
  pageReadAwareRoutineRunner,
  withCommittedPageRead,
} from "../../src/modules/chat/services/routines/pageReadAwareRoutineRunner.js";

const routine: Routine = {
  id: "booking",
  rootStepId: "answer",
  steps: [
    { id: "answer", kind: "chat", action: "Answer from what the lookup found." },
    { id: "confirm", kind: "chat", action: "Name the course on {{context.page_context}}.", metadata: { contextRefs: ["page_context"] } },
  ],
  transitions: [{ from: "answer", to: "confirm", condition: "always" }],
};

const preparedResolvedContext = { fragments: [], renderFragments: [], staged: [], snapshot: {} };

const session = (): PreparedSession => ({
  effectiveQuery: "book this edition",
  pageContext: { pageUrl: "https://example.test/courses/autumn", content: "Autumn retreat, 30 Oct to 2 Nov." },
  pageReadCapability: { available: true, mode: "content", supportedOperations: ["metadata", "lookup", "summarize"] },
  resolvedContext: preparedResolvedContext,
  stagedContext: [],
}) as unknown as PreparedSession;

const resumeInput = {
  turn: { stagedContext: [] },
  state: { routineId: "booking", path: [], variables: {}, status: "active" },
} as unknown as ConversationRoutineResumeInput;

/**
 * A runner that claims the turn with `reply`, rendering `landedStepId` (the page step by
 * default), over a preparer whose commit marks the session it changed.
 */
const runnerFor = (target: PreparedSession, reply: PendingRenderableTurn, landedStepId = "confirm") => {
  const inner: ConversationRoutineRunner = {
    resume: async () => {
      throw new Error("the claim is the whole walk");
    },
    claim: async () => ({ kind: "claimed", effects: { trace: { landedStepId } } as never, reply }),
  };
  return pageReadAwareRoutineRunner({
    session: target,
    routines: [routine],
    runner: inner,
    chatSessionPreparer: {
      stagedPageContextFor: () => [],
      applyFrozenPageReadOutcome: (committed) => {
        committed.resolvedContext = { ...committed.resolvedContext, snapshot: { page_context: { committed: true } } };
        committed.stagedContext = [{ kind: "context_variable", id: "page_context", data: {} }];
      },
    },
  });
};

const claimReply = async (runner: ConversationRoutineRunner): Promise<PendingRenderableTurn> => {
  const claimed = await runner.claim!(resumeInput);
  if (claimed.kind !== "claimed") {
    throw new Error("expected the routine to claim the turn");
  }
  return claimed.reply;
};

const turn: RenderableTurn = { answer: "Which date suits you?" };

describe("pageReadAwareRoutineRunner", () => {
  it("commits the page read before the reply of a step that reads the page, so the reply sees it", async () => {
    const target = session();
    let seen: unknown;
    const reply = await claimReply(runnerFor(target, {
      render: async () => {
        seen = target.pageReadOutcome?.gate.kind;
        return turn;
      },
    }));

    await reply.render();

    expect(seen).toBe("capture");
  });

  it("commits the page read only after the reply of a step that does not read the page", async () => {
    const target = session();
    let seen: unknown = "not rendered";
    const reply = await claimReply(runnerFor(target, {
      render: async () => {
        seen = target.pageReadOutcome;
        return turn;
      },
    }, "answer"));

    await reply.render();

    expect(seen).toBeUndefined();
    expect(target.pageReadOutcome?.gate.kind).toBe("capture");
  });

  it("commits nothing when the reply of a step that does not read the page fails", async () => {
    const target = session();
    const reply = await claimReply(runnerFor(target, {
      render: async () => {
        throw new Error("model unavailable");
      },
    }, "answer"));

    await expect(reply.render()).rejects.toThrow("model unavailable");

    expect(target.pageReadOutcome).toBeUndefined();
    expect(target.resolvedContext).toBe(preparedResolvedContext);
  });

  it("leaves the page read committed once the reply has been generated", async () => {
    const target = session();
    const reply = await claimReply(runnerFor(target, { render: async () => turn }));

    await expect(reply.render()).resolves.toEqual(turn);

    expect(target.pageReadOutcome?.gate.kind).toBe("capture");
    expect(target.resolvedContext.snapshot).toEqual({ page_context: { committed: true } });
  });

  it("undoes the commit when generating the whole reply fails", async () => {
    const target = session();
    const reply = await claimReply(runnerFor(target, {
      render: async () => {
        throw new Error("model unavailable");
      },
    }));

    await expect(reply.render()).rejects.toThrow("model unavailable");

    expect(target.pageReadOutcome).toBeUndefined();
    expect(target.resolvedContext).toBe(preparedResolvedContext);
    expect(target.stagedContext).toEqual([]);
  });

  it("undoes the commit when a streamed reply fails partway", async () => {
    const target = session();
    const reply = await claimReply(runnerFor(target, {
      render: async () => turn,
      stream: async function* () {
        yield "Which ";
        throw new Error("stream dropped");
      },
    }));

    const stream = reply.stream!();
    await expect(stream.next()).resolves.toEqual({ done: false, value: "Which " });
    await expect(stream.next()).rejects.toThrow("stream dropped");

    expect(target.pageReadOutcome).toBeUndefined();
    expect(target.resolvedContext).toBe(preparedResolvedContext);
  });

  it("undoes the commit when the caller abandons a streamed reply", async () => {
    const target = session();
    const reply = await claimReply(runnerFor(target, {
      render: async () => turn,
      stream: async function* () {
        yield "Which ";
        yield "date?";
        return turn;
      },
    }));

    const stream = reply.stream!();
    await stream.next();
    await stream.return(turn);

    expect(target.pageReadOutcome).toBeUndefined();
    expect(target.resolvedContext).toBe(preparedResolvedContext);
  });

  describe("the page read it reports for the caller to apply", () => {
    const streamable = (): PendingRenderableTurn => ({
      render: async () => turn,
      stream: async function* () {
        yield "Which ";
        yield "date?";
        return turn;
      },
    });
    const drain = async (reply: PendingRenderableTurn): Promise<void> => {
      const stream = reply.stream!();
      let step = await stream.next();
      while (!step.done) {
        step = await stream.next();
      }
    };

    it.each([
      { delivery: "rendered whole", step: "confirm", generate: (reply: PendingRenderableTurn) => reply.render() },
      { delivery: "streamed", step: "confirm", generate: drain },
      { delivery: "rendered whole", step: "answer", generate: (reply: PendingRenderableTurn) => reply.render() },
      { delivery: "streamed", step: "answer", generate: drain },
    ])(
      "records the page read on a copy of the session made between claim and reply end ($delivery, landing on $step)",
      async ({ step, generate }) => {
        const target = session();
        const runner = runnerFor(target, streamable(), step);
        const reply = await claimReply(runner);
        const copy: PreparedSession = { ...target, responseLanguage: "de" };

        await generate(reply);
        const persisted = withCommittedPageRead(copy, runner.committedPageRead());

        expect(persisted.responseLanguage).toBe("de");
        expect(pageReadRecordOf(persisted.pageReadOutcome!)).toMatchObject({
          decision: { required: true, operation: "context" },
          winnerSource: { kind: "routine", routineId: "booking" },
          gateOutcome: "capture",
        });
        expect(persisted.resolvedContext.snapshot).toEqual({ page_context: { committed: true } });
        expect(persisted.stagedContext).toEqual([{ kind: "context_variable", id: "page_context", data: {} }]);
      },
    );

    it("reports nothing before the reply has been generated", async () => {
      const runner = runnerFor(session(), streamable(), "answer");
      await claimReply(runner);

      expect(runner.committedPageRead()).toBeUndefined();
    });

    it("reports nothing once a failed reply undid the commit", async () => {
      const runner = runnerFor(session(), {
        render: async () => {
          throw new Error("model unavailable");
        },
      });
      const reply = await claimReply(runner);

      await expect(reply.render()).rejects.toThrow("model unavailable");

      expect(runner.committedPageRead()).toBeUndefined();
    });

    it("leaves a session untouched when nothing was committed", () => {
      const target = session();

      expect(withCommittedPageRead(target, undefined)).toBe(target);
    });
  });

  describe("a correction after the routine ended, through the runner as chat builds it (#1544)", () => {
    const intake: Routine = {
      id: "intake",
      rootStepId: "ask_health",
      slots: [{ id: "slot_pregnant", key: "pregnant", type: "boolean", required: true, sensitivity: "sensitive", mutable: true }],
      consents: [{ key: "health", slotKeys: ["pregnant"], onDecline: "continue" }],
      steps: [{ id: "ask_health", kind: "chat" }, { id: "done", kind: "terminal" }],
      transitions: [{ from: "ask_health", to: "done", condition: "always" }],
    };
    const completed: RoutineState = {
      sessionId: "session_1",
      routineId: "intake",
      path: ["ask_health", "done"],
      variables: { pregnant: true },
      status: "completed",
    };

    it("never writes a slot the routine's consent covers", async () => {
      const save = vi.fn(async () => {});
      const routineRunner = pageReadAwareRoutineRunner({
        session: session(),
        routines: [intake],
        runner: new DefaultRoutineRunner([intake], { select: vi.fn() }, { render: vi.fn() }),
        chatSessionPreparer: { stagedPageContextFor: () => [], applyFrozenPageReadOutcome: () => {} },
      });

      const result = await new DefaultConversationEngine().attemptRoutine({
        agent: { id: "agent_1", name: "Assistant" },
        sessionId: "session_1",
        inputEvent: { id: "input_1", kind: "message", content: "actually, I am not pregnant" },
        stores: { loadHistory: vi.fn(async () => []), appendEvent: vi.fn(async () => {}) },
        routineStore: {
          loadActive: vi.fn(async () => null),
          loadCompleted: vi.fn(async () => [completed]),
          save,
          clear: vi.fn(async () => {}),
        },
        routineRunner,
        routineSlotCorrection: {
          // The chat corrector never offers a covered slot; the engine refuses one all the same.
          detect: vi.fn(async () => ({
            kind: "correction" as const,
            slots: intake.slots ?? [],
            consents: intake.consents ?? [],
            slotKey: "pregnant",
            rawValue: "false",
          })),
          confirm: vi.fn(async () => "Updated."),
          rejectInvalid: vi.fn(async () => "Which value?"),
        },
      });

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });
  });
});
