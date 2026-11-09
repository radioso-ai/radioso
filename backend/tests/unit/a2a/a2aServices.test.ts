import { describe, expect, it, vi } from "vitest";

import type { AgentConverseTurnResult } from "../../../src/modules/chat/contracts/index.js";
import type { A2aTaskRecord, A2aTranscriptMessage, A2aTranscriptPort } from "../../../src/modules/a2a/public.js";
import { A2aSendMessageService, A2aTaskReader, A2aTaskView, createA2aObserver } from "../../../src/modules/a2a/public.js";
import type { A2aContextAdmission } from "../../../src/modules/a2a/services/a2aAccess.js";
import type { AgentConverseOpening, AgentConversePrincipal } from "../../../src/modules/settings/contracts/agentConverseSession.js";
import { InMemoryA2aMessageReceiptStore, InMemoryA2aTaskStore } from "../../support/a2aStores.js";

const CONVERSATION_ID = "conv-1";

/** A conversation whose cursor is the count of messages read. */
class FakeTranscript implements A2aTranscriptPort {
  readonly messages: A2aTranscriptMessage[] = [];
  ownership: "ai_owned" | "human_owned" = "ai_owned";
  onRead: (() => Promise<void>) | null = null;

  add(source: string, text: string): string {
    const id = `m${this.messages.length + 1}`;
    this.messages.push({ id, source, text, createdAt: new Date().toISOString() });
    return id;
  }

  async conversationIdFor() {
    return this.messages.length > 0 ? CONVERSATION_ID : null;
  }

  async readAfter(input: { cursor: string | null; limit: number }) {
    const hook = this.onRead;
    this.onRead = null;
    await hook?.();
    const start = input.cursor ? Number(input.cursor) : Math.max(0, this.messages.length - input.limit);
    const page = this.messages.slice(start, start + input.limit);
    return { messages: page, cursor: this.messages.length > 0 ? String(start + page.length) : null, ownership: this.ownership };
  }

  async readRange(input: { fromMessageId: string; throughMessageId: string; limit: number }) {
    const from = this.messages.findIndex((message) => message.id === input.fromMessageId);
    const through = this.messages.findIndex((message) => message.id === input.throughMessageId);
    return from < 0 || through < from ? [] : this.messages.slice(Math.max(from, through + 1 - input.limit), through + 1);
  }
}

const opening: AgentConverseOpening = {
  workspaceId: "w-1",
  agentId: "a-1",
  publicSessionId: "s-1",
  origin: { kind: "walk_in", publicId: "ag_x" },
  expiresAt: null,
};

const admission = (task: A2aTaskRecord | null = null): A2aContextAdmission => ({
  kind: "context",
  principal: { workspaceId: "w-1", agentId: "a-1", publicSessionId: "s-1" } as AgentConversePrincipal,
  opening,
  contextToken: "ctx-token",
  conversationId: CONVERSATION_ID,
  task,
});

const openTask = (overrides: Partial<A2aTaskRecord> = {}): Omit<A2aTaskRecord, "version"> => ({
  id: "task-0000000000000001",
  workspaceId: "w-1",
  conversationId: CONVERSATION_ID,
  contextToken: "ctx-token",
  contextExpiresAt: null,
  routineExecutionId: "exec-1",
  openingMessageId: "m1",
  callerMessageId: "m1",
  cursor: "2",
  shownThroughMessageId: "m2",
  statusMessageId: "m2",
  artifactMessageId: null,
  envelope: null,
  state: "input_required",
  reason: "awaiting_input",
  humanStretch: false,
  stateAt: new Date("2026-11-09T10:00:00.000Z"),
  ...overrides,
});

type TurnFacts = Partial<Pick<AgentConverseTurnResult, "activeRoutineExecutionId" | "requestMessageId" | "replyMessageId">> & {
  ownership?: "ai_owned" | "human_owned";
  text?: string;
};

const turnResult = (
  routine: AgentConverseTurnResult["reply"]["routine"] | null,
  routineExecutionId: string | null,
  facts: TurnFacts = {},
): AgentConverseTurnResult => ({
  reply: {
    conversationId: "s-1",
    answerCoverage: { availability: "not_recorded", originatingTurnId: "", originatingRequestId: "" },
    ownership: { state: facts.ownership ?? "ai_owned", suppressed: false },
    ...(routine ? { routine } : {}),
    answer: { text: facts.text ?? "Done.", citations: [] },
  },
  routineExecutionId,
  activeRoutineExecutionId: facts.activeRoutineExecutionId ?? null,
  requestMessageId: facts.requestMessageId ?? null,
  replyMessageId: facts.replyMessageId ?? null,
});

const TASK_ID = "task-0000000000000001";

const setUp = async (options: { task?: Partial<A2aTaskRecord> | null; logger?: { info: () => void; warn: () => void } } = {}) => {
  const transcript = new FakeTranscript();
  transcript.add("customer", "I need support intake");
  transcript.add("ai_agent", "What topic?");
  const tasks = new InMemoryA2aTaskStore();
  if (options.task !== null) {
    await tasks.commit({ updates: [], insert: openTask(options.task) });
  }
  const receipts = new InMemoryA2aMessageReceiptStore();
  const observer = createA2aObserver({ ...(options.logger ? { logger: options.logger } : {}) });
  const view = new A2aTaskView({ transcript });
  return { transcript, tasks, receipts, observer, view };
};

const storedTask = async (tasks: InMemoryA2aTaskStore): Promise<A2aTaskRecord> => {
  const task = await tasks.findById(TASK_ID);
  if (!task) throw new Error("expected the task");
  return task;
};

const sendInput = (messageId: string, text: string, taskId: string | null = null) =>
  ({ messageId, text, contextId: "ctx-token", taskId, historyLength: null });

describe("A2A task writes under concurrency", () => {
  it("never lets a read computed from an older snapshot overwrite a turn's result", async () => {
    const { transcript, tasks, observer, view } = await setUp();
    transcript.add("human_agent", "A teammate here.");
    const stale = await tasks.findById("task-0000000000000001");
    if (!stale) throw new Error("expected the task");
    // The turn settles while the read is between its snapshot and its write.
    transcript.onRead = async () => {
      await tasks.commit({ updates: [{ id: stale.id, expectedVersion: 1, changes: { state: "completed", reason: "routine_completed" } }] });
    };

    const read = await new A2aTaskReader({ tasks, transcript, view, observer }).get(admission(stale), { id: stale.id, historyLength: null }, { extensionActive: false });

    expect(read.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await tasks.findById(stale.id)).toMatchObject({ state: "completed", reason: "routine_completed", version: 2 });
  });

  it("re-decides a turn against the task a read moved while it ran, and still writes the turn's result", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp();
    const task = await tasks.findById("task-0000000000000001");
    if (!task) throw new Error("expected the task");
    const converse = {
      askAgent: vi.fn(async () => {
        // A read observed a person's message and moved the task first.
        await tasks.commit({ updates: [{ id: task.id, expectedVersion: 1, changes: { state: "input_required", reason: "human_message" } }] });
        const requestMessageId = transcript.add("customer", "topic: billing");
        const replyMessageId = transcript.add("ai_agent", "Done.");
        return turnResult({ name: "Support intake", status: "completed", pendingInput: [] }, "exec-1", { requestMessageId, replyMessageId });
      }),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    const result = await send.send(admission(task), { messageId: "c-1", text: "topic: billing", contextId: "ctx-token", taskId: task.id, historyLength: null }, { extensionActive: false });

    expect("task" in result && result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await tasks.findById(task.id)).toMatchObject({ state: "completed", reason: "routine_completed", artifactMessageId: "m4", version: 3 });
  });

  it("answers TURN_IN_PROGRESS to a retry while the first send runs, and releases a failed send's claim", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp();
    let release: () => void = () => undefined;
    const converse = {
      askAgent: vi.fn(() => new Promise<AgentConverseTurnResult>((_resolve, reject) => {
        release = () => reject(new Error("model unavailable"));
      })),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });
    const input = { messageId: "c-9", text: "Hello", contextId: "ctx-token", taskId: null, historyLength: null };

    const first = send.send(admission(), input, { extensionActive: false });
    await vi.waitFor(() => expect(converse.askAgent).toHaveBeenCalledTimes(1));
    await expect(send.send(admission(), input, { extensionActive: false })).rejects.toMatchObject({ reason: "TURN_IN_PROGRESS", code: -32000 });

    release();
    await expect(first).rejects.toThrow("model unavailable");
    expect(receipts.receipts.size).toBe(0);
  });

  it("answers -32004 to a message for a terminal task, without running a turn", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp();
    const converse = { askAgent: vi.fn() };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });
    const terminal = { ...openTask({ state: "completed", reason: "routine_completed" }), version: 2 };

    await expect(send.send(admission(terminal), { messageId: "c-2", text: "More", contextId: null, taskId: terminal.id, historyLength: null }, { extensionActive: false }))
      .rejects.toMatchObject({ code: -32004, reason: "UNSUPPORTED_OPERATION" });
    expect(converse.askAgent).not.toHaveBeenCalled();
  });

  it("keeps a stretch of human ownership one when a read lands between the turn's load and its write", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({
      task: { routineExecutionId: null, state: "working", reason: "human_owned", humanStretch: true, statusMessageId: null },
    });
    const task = await storedTask(tasks);
    const reader = new A2aTaskReader({ tasks, transcript, view, observer });
    const converse = {
      askAgent: vi.fn(async () => {
        // The person handed back; the AI answers this turn.
        const requestMessageId = transcript.add("customer", "Thanks!");
        const replyMessageId = transcript.add("ai_agent", "Glad to help.");
        // A GetTask reads the reply as an agent message before the turn writes, and records that reason.
        transcript.onRead = async () => {
          await reader.get(admission(task), { id: task.id, historyLength: null }, { extensionActive: false });
        };
        return turnResult(null, null, { requestMessageId, replyMessageId, text: "Glad to help." });
      }),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    const result = await send.send(admission(task), sendInput("c-4", "Thanks!", task.id), { extensionActive: false });

    expect("task" in result && result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await storedTask(tasks)).toMatchObject({ state: "completed", reason: "handed_back", humanStretch: true, version: 3 });
  });
});

describe("A2A turns: the turn's own messages", () => {
  it("answers with the turn's own reply when an overlapping turn on the context stored its messages after it", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({ task: null });
    const converse = {
      askAgent: vi.fn(async () => {
        const requestMessageId = transcript.add("customer", "Where is my parcel?");
        const replyMessageId = transcript.add("ai_agent", "On its way.");
        // Another instance's turn on the same context landed after this one's.
        transcript.add("customer", "And my refund?");
        transcript.add("ai_agent", "Refunded.");
        return turnResult(null, null, { requestMessageId, replyMessageId, text: "On its way." });
      }),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    const result = await send.send(admission(), sendInput("c-5", "Where is my parcel?"), { extensionActive: false });
    const replayed = await send.send(admission(), sendInput("c-5", "Where is my parcel?"), { extensionActive: false });

    expect(result).toMatchObject({ message: { messageId: "m4", parts: [{ text: "On its way." }] } });
    expect(replayed).toEqual(result);
    expect(converse.askAgent).toHaveBeenCalledTimes(1);
  });

  it("records no receipt for a plain answer whose reply was never stored, rather than inventing a message id", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({ task: null });
    const converse = {
      askAgent: vi.fn(async () => turnResult(null, null, { requestMessageId: transcript.add("customer", "Hello") })),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    await expect(send.send(admission(), sendInput("c-6", "Hello"), { extensionActive: false })).rejects.toThrow();
    expect(receipts.receipts.size).toBe(0);
  });

  it("finds a person's reply after the turn's message past a full page of messages since the cursor", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({
      task: { routineExecutionId: null, state: "working", reason: "human_owned", humanStretch: true },
    });
    for (let note = 0; note < 55; note += 1) {
      transcript.add("system", `note ${note}`);
    }
    const task = await storedTask(tasks);
    const converse = {
      askAgent: vi.fn(async () => {
        const requestMessageId = transcript.add("customer", "Order 1042, please.");
        // A person answers while the turn runs; no AI reply is generated under human ownership.
        transcript.add("human_agent", "Found it.");
        return turnResult(null, null, { ownership: "human_owned", requestMessageId, text: "" });
      }),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    const result = await send.send(admission(task), sendInput("c-7", "Order 1042, please.", task.id), { extensionActive: false });

    expect("task" in result && result.task.status).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "Found it." }] } });
  });
});

describe("A2A receipts: claims belong to the send that holds them", () => {
  it("lets a takeover's claim stand against the slow send it replaced, whether that send finishes or fails", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({ task: null });
    let now = Date.now();
    const finish: Array<(turn: AgentConverseTurnResult) => void> = [];
    const converse = {
      askAgent: vi.fn(() => new Promise<AgentConverseTurnResult>((resolve) => {
        finish.push(resolve);
      })),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer, clock: () => new Date(now) });
    const receipt = () => [...receipts.receipts.values()][0];

    const first = send.send(admission(), sendInput("c-8", "Hello"), { extensionActive: false });
    await vi.waitFor(() => expect(converse.askAgent).toHaveBeenCalledTimes(1));
    // Ten minutes on, the first send looks dead and a retry takes its claim over.
    now += 11 * 60 * 1_000;
    const takeover = send.send(admission(), sendInput("c-8", "Hello"), { extensionActive: false });
    await vi.waitFor(() => expect(converse.askAgent).toHaveBeenCalledTimes(2));

    const firstReply = transcript.add("ai_agent", "first");
    finish[0]?.(turnResult(null, null, { requestMessageId: "m1", replyMessageId: firstReply, text: "first" }));
    await first;
    expect(receipt()).toMatchObject({ state: "in_flight", result: null });

    const takeoverReply = transcript.add("ai_agent", "second");
    finish[1]?.(turnResult(null, null, { requestMessageId: "m1", replyMessageId: takeoverReply, text: "second" }));
    await takeover;
    expect(receipt()).toMatchObject({ state: "completed", result: { kind: "message", replyMessageId: takeoverReply } });
  });

  it("never releases a takeover's claim when the stale send it replaced fails", async () => {
    const { transcript, tasks, receipts, observer, view } = await setUp({ task: null });
    let now = Date.now();
    const fail: Array<(error: Error) => void> = [];
    const converse = {
      askAgent: vi.fn(() => new Promise<AgentConverseTurnResult>((_resolve, reject) => {
        fail.push(reject);
      })),
    };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer, clock: () => new Date(now) });

    const stale = send.send(admission(), sendInput("c-9", "Hello"), { extensionActive: false });
    await vi.waitFor(() => expect(converse.askAgent).toHaveBeenCalledTimes(1));
    now += 11 * 60 * 1_000;
    void send.send(admission(), sendInput("c-9", "Hello"), { extensionActive: false }).catch(() => undefined);
    await vi.waitFor(() => expect(converse.askAgent).toHaveBeenCalledTimes(2));

    fail[0]?.(new Error("model unavailable"));
    await expect(stale).rejects.toThrow("model unavailable");

    expect([...receipts.receipts.values()]).toEqual([expect.objectContaining({ state: "in_flight" })]);
    // A retry while the takeover's claim is fresh still finds the message being answered.
    now = Date.now();
    await expect(send.send(admission(), sendInput("c-9", "Hello"), { extensionActive: false })).rejects.toMatchObject({ reason: "TURN_IN_PROGRESS" });
    fail[1]?.(new Error("model unavailable"));
  });

  it("logs a release that failed at warn, with digests only, and still answers the turn's own failure", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { transcript, tasks, receipts, observer, view } = await setUp({ task: null, logger });
    receipts.release = vi.fn(async () => {
      throw new Error("connection to db.internal.example lost");
    });
    const converse = { askAgent: vi.fn(async () => { throw new Error("model unavailable"); }) };
    const send = new A2aSendMessageService({ converse, tasks, receipts, transcript, view, observer });

    await expect(send.send(admission(), sendInput("client-message-10", "Hello"), { extensionActive: false })).rejects.toThrow("model unavailable");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ conversationDigest: expect.any(String) }), expect.any(String));
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(CONVERSATION_ID);
    expect(logged).not.toContain("client-message-10");
    expect(logged).not.toContain("db.internal.example");
  });
});

describe("A2A reads", () => {
  it("keeps the turn's report when a read moves the task, changing only who owns the thread", async () => {
    const envelope = {
      answerCoverage: { availability: "not_recorded" as const, originatingTurnId: "m1", originatingRequestId: "m1" },
      ownership: { state: "ai_owned" as const, suppressed: false },
      routine: { name: "Support intake", status: "waiting_for_input" as const, pendingInput: [{ key: "topic", type: "text", required: true, description: "The support topic" }] },
      citations: [{ documentId: "d-1", title: "Returns policy", chunkId: "c-1" }],
    };
    const { transcript, tasks, observer, view } = await setUp({ task: { envelope: envelope as A2aTaskRecord["envelope"] } });
    transcript.add("human_agent", "A teammate here.");
    transcript.ownership = "human_owned";

    await new A2aTaskReader({ tasks, transcript, view, observer }).get(admission(await storedTask(tasks)), { id: TASK_ID, historyLength: null }, { extensionActive: true });

    expect((await storedTask(tasks)).envelope).toEqual({ ...envelope, ownership: { state: "human_owned", suppressed: false } });
  });

  it("reports the newest reply past the cursor, however many messages landed since", async () => {
    const { transcript, tasks, observer, view } = await setUp();
    for (let note = 0; note < 60; note += 1) {
      transcript.add("human_agent", `update ${note}`);
    }

    const read = await new A2aTaskReader({ tasks, transcript, view, observer }).get(admission(await storedTask(tasks)), { id: TASK_ID, historyLength: 0 }, { extensionActive: false });

    expect(read.status.message?.parts).toEqual([{ text: "update 59" }]);
    expect(await storedTask(tasks)).toMatchObject({ statusMessageId: "m62", shownThroughMessageId: "m62", cursor: "62" });
  });
});
