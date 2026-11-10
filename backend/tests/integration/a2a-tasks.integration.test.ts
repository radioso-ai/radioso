import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import { A2A_CONVERSE_EXTENSION_URI } from "../../src/shared/domain/a2aConverseExtension.js";
import {
  conversationIdForContext,
  createA2aTestApp,
  issueConverseGrant,
  openA2aAgent,
  operatorOf,
  rpc,
  sendText,
  supportIntakeDraft,
  supportIntakeWithApprovalDraft,
  type A2aTestApp,
} from "../support/a2aTestApp.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";

const withRoutine = async (ctx: A2aTestApp, draft = supportIntakeDraft()) => {
  const opened = await openA2aAgent(ctx);
  await ctx.dependencies.routineDefinitionService.createDraft(opened.session.workspaceId, opened.agent.id, draft);
  return opened;
};

/** The routine run's state leaves the store, as an expired one does: `loadActive` never returns it. */
const expireRoutine = async (ctx: A2aTestApp, contextId: string) => {
  ctx.routineStateStore.states.delete(await conversationIdForContext(ctx, contextId));
};

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const assistantReplies = async (ctx: A2aTestApp, workspaceId: string, conversationId: string) =>
  (await ctx.repositories.messageRepository.listByConversationId(workspaceId, conversationId))
    .filter((message) => message.role === "assistant" && (message.source ?? "ai_agent") === "ai_agent");

describe("A2A tasks: a routine over several turns (US2)", () => {
  it("opens a task at INPUT_REQUIRED, completes it with an artifact, and reads and lists it", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);

    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    const task = started.body.result.task;
    expect(task).toMatchObject({
      id: expect.any(String),
      contextId: expect.any(String),
      status: {
        state: "TASK_STATE_INPUT_REQUIRED",
        message: { role: "ROLE_AGENT", taskId: task.id, parts: [{ text: expect.any(String) }] },
        timestamp: expect.any(String),
      },
    });
    expect(task.id.length).toBeGreaterThanOrEqual(22);
    expect(task.history.map((message: { role: string }) => message.role)).toEqual(["ROLE_USER", "ROLE_AGENT"]);
    expect(task.artifacts).toBeUndefined();

    const read = await rpc(ctx, publicId, "GetTask", { id: task.id }).expect(200);
    expect(read.body.result).toEqual(task);

    const completed = await sendText(ctx, publicId, "topic: billing", { taskId: task.id, contextId: task.contextId }, {
      extensions: A2A_CONVERSE_EXTENSION_URI,
    }).expect(200);
    const done = completed.body.result.task;
    expect(done.id).toBe(task.id);
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.status.message).toBeUndefined();
    expect(done.artifacts).toEqual([{
      artifactId: expect.any(String),
      name: "Support intake",
      parts: [{ text: expect.any(String) }],
      extensions: [A2A_CONVERSE_EXTENSION_URI],
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: expect.objectContaining({ author: "agent", routine: expect.objectContaining({ status: "completed" }) }) },
    }]);
    expect(done.metadata).toEqual({ [A2A_CONVERSE_EXTENSION_URI]: { reason: "routine_completed" } });
    expect(done.history.map((message: { role: string }) => message.role)).toEqual(["ROLE_USER", "ROLE_AGENT", "ROLE_USER", "ROLE_AGENT"]);

    const listed = await rpc(ctx, publicId, "ListTasks", { contextId: task.contextId, includeArtifacts: true, historyLength: 1 }).expect(200);
    expect(listed.body.result.tasks).toHaveLength(1);
    expect(listed.body.result.tasks[0]).toMatchObject({ id: task.id, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [expect.any(Object)] });
    expect(listed.body.result.tasks[0].history).toHaveLength(1);

    const toTerminal = await sendText(ctx, publicId, "Anything else?", { taskId: task.id }).expect(200);
    expect(toTerminal.body.error).toMatchObject({ code: -32004, data: [{ reason: "UNSUPPORTED_OPERATION" }] });
    const cancel = await rpc(ctx, publicId, "CancelTask", { id: task.id }).expect(200);
    expect(cancel.body.error).toMatchObject({ code: -32002, data: [{ reason: "TASK_NOT_CANCELABLE" }] });
    const unknown = await rpc(ctx, publicId, "CancelTask", { id: "AAAAAAAAAAAAAAAAAAAAAA" }).expect(200);
    expect(unknown.body.error).toMatchObject({ code: -32001, data: [{ reason: "TASK_NOT_FOUND" }] });
  });

  it("continues the open task from the context alone", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);

    const completed = await sendText(ctx, publicId, "topic: refunds", { contextId: started.body.result.task.contextId }).expect(200);

    expect(completed.body.result.task).toMatchObject({ id: started.body.result.task.id, status: { state: "TASK_STATE_COMPLETED" } });
  });

  it("keeps the task open at INPUT_REQUIRED when the routine yields to an off-topic message, and continues it after", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    const { id, contextId } = started.body.result.task;

    const offTopic = await sendText(ctx, publicId, "Something unrelated: what are your hours?", { taskId: id, contextId }, {
      extensions: A2A_CONVERSE_EXTENSION_URI,
    }).expect(200);

    expect(offTopic.body.result.task).toMatchObject({
      id,
      status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: expect.stringContaining("agent:Something unrelated") }] } },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "awaiting_input" } },
    });
    // The yield left the run where it was, so the task still says what the routine waits for.
    expect(offTopic.body.result.task.status.message.metadata[A2A_CONVERSE_EXTENSION_URI].routine).toMatchObject({
      status: "waiting_for_input",
      pendingInput: [expect.objectContaining({ key: "topic" })],
    });

    const completed = await sendText(ctx, publicId, "topic: billing", { taskId: id, contextId }).expect(200);
    expect(completed.body.result.task).toMatchObject({ id, status: { state: "TASK_STATE_COMPLETED" } });
  });

  it("ends the task CANCELED with reason routine_ended once its routine is no longer active, on the turn's reply", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    const { id, contextId } = started.body.result.task;
    await expireRoutine(ctx, contextId);

    const movedOn = await sendText(ctx, publicId, "Thanks, no routine needed", { contextId }, {
      extensions: A2A_CONVERSE_EXTENSION_URI,
    }).expect(200);

    expect(movedOn.body.result.task).toMatchObject({
      id,
      status: { state: "TASK_STATE_CANCELED", message: { parts: [{ text: "agent:Thanks, no routine needed" }] } },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "routine_ended" } },
    });
  });

  it("ends the task CANCELED with reason routine_replaced when another routine run starts, and opens a task for it", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    const { id, contextId } = started.body.result.task;
    await expireRoutine(ctx, contextId);

    const restarted = await sendText(ctx, publicId, "I need support intake again", { contextId }).expect(200);

    const replacement = restarted.body.result.task;
    expect(replacement.id).not.toBe(id);
    expect(replacement.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const replaced = await rpc(ctx, publicId, "GetTask", { id }, { extensions: A2A_CONVERSE_EXTENSION_URI }).expect(200);
    expect(replaced.body.result).toMatchObject({
      status: { state: "TASK_STATE_CANCELED" },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "routine_replaced" } },
    });
    expect(replaced.body.result.status.message).toBeUndefined();
    const listed = await rpc(ctx, publicId, "ListTasks", { contextId }).expect(200);
    expect(listed.body.result.tasks.map((task: { id: string }) => task.id).sort()).toEqual([id, replacement.id].sort());
  });

  it("answers an unknown task id, another agent's, and another grant's identically", async () => {
    const ctx = createA2aTestApp();
    const first = await withRoutine(ctx);
    const second = await withRoutine(ctx);
    const grant = await issueConverseGrant(ctx, first.agent);
    const otherGrant = await issueConverseGrant(ctx, first.agent);
    const walkInTask = (await sendText(ctx, first.publicId, "I need support intake").expect(200)).body.result.task;
    const grantTask = (await sendText(ctx, first.publicId, "I need support intake", {}, { bearer: grant.token }).expect(200)).body.result.task;

    const unknown = await rpc(ctx, first.publicId, "GetTask", { id: "AAAAAAAAAAAAAAAAAAAAAA" }).expect(200);
    const otherAgent = await rpc(ctx, second.publicId, "GetTask", { id: walkInTask.id }).expect(200);
    const underOtherGrant = await rpc(ctx, first.publicId, "GetTask", { id: grantTask.id }, { bearer: otherGrant.token }).expect(200);
    const underItsGrant = await rpc(ctx, first.publicId, "GetTask", { id: grantTask.id }, { bearer: grant.token }).expect(200);

    expect(unknown.body.error).toMatchObject({ code: -32001, data: [{ reason: "TASK_NOT_FOUND", metadata: {} }] });
    expect(otherAgent.body.error).toEqual(unknown.body.error);
    expect(underOtherGrant.body.error).toEqual(unknown.body.error);
    expect(underItsGrant.body.result.id).toBe(grantTask.id);
  });

  it("counts requests and task transitions with no agent, context or task in a label", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await withRoutine(ctx);
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    await sendText(ctx, publicId, "topic: billing", { contextId: started.body.result.task.contextId }).expect(200);
    await rpc(ctx, publicId, "GetTask", { id: "AAAAAAAAAAAAAAAAAAAAAA" }).expect(200);

    const metrics = (ctx.dependencies.metricsRegistry?.renderPrometheus() ?? "").split("\n");
    expect(metrics).toContain('radioso_a2a_requests_total{method="SendMessage",outcome="ok"} 2');
    expect(metrics).toContain('radioso_a2a_requests_total{method="GetTask",outcome="TASK_NOT_FOUND"} 1');
    expect(metrics).toContain('radioso_a2a_task_transitions_total{to_state="input_required"} 1');
    expect(metrics).toContain('radioso_a2a_task_transitions_total{to_state="completed"} 1');
    expect(metrics.filter((line) => line.startsWith("radioso_a2a_")).join("\n")).not.toContain(started.body.result.task.id);
  });
});

describe("A2A tasks: a person takes over, and the caller comes back (US3)", () => {
  it("is WORKING after a handoff, INPUT_REQUIRED on a person's reply, and COMPLETED after the hand-back", async () => {
    const ctx = createA2aTestApp();
    const { session, agent, publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const conversationId = await conversationIdForContext(ctx, contextId);
    const operator = operatorOf(ctx, session, conversationId);

    const takeover = await operator.takeOver();
    const waiting = await sendText(ctx, publicId, "Can a person help?", { contextId }).expect(200);
    const task = waiting.body.result.task;
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    expect(task.status.message).toBeUndefined();
    expect(await assistantReplies(ctx, agent.workspaceId, conversationId)).toHaveLength(1);

    const replied = await operator.reply("I can help with that.", takeover.body.ownership.version);
    const read = await rpc(ctx, publicId, "GetTask", { id: task.id }, { extensions: A2A_CONVERSE_EXTENSION_URI }).expect(200);
    expect(read.body.result.status).toMatchObject({
      state: "TASK_STATE_INPUT_REQUIRED",
      message: {
        role: "ROLE_AGENT",
        parts: [{ text: "I can help with that." }],
        metadata: { [A2A_CONVERSE_EXTENSION_URI]: expect.objectContaining({ author: "human" }) },
      },
    });
    // Sticky: nothing new since, so a second read answers the same.
    const reread = await rpc(ctx, publicId, "GetTask", { id: task.id }, { extensions: A2A_CONVERSE_EXTENSION_URI }).expect(200);
    expect(reread.body.result).toEqual(read.body.result);

    const answered = await sendText(ctx, publicId, "Order 1042, please.", { taskId: task.id, contextId }).expect(200);
    expect(answered.body.result.task).toMatchObject({ id: task.id, status: { state: "TASK_STATE_WORKING" } });
    expect(await assistantReplies(ctx, agent.workspaceId, conversationId)).toHaveLength(1);

    await operator.handBack(replied.body.ownership?.version ?? takeover.body.ownership.version);
    const back = await sendText(ctx, publicId, "Thanks!", { taskId: task.id, contextId }).expect(200);
    expect(back.body.result.task).toMatchObject({
      id: task.id,
      status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "agent:Thanks!" }] } },
    });
    expect(back.body.result.task.history.map((message: { parts: [{ text: string }] }) => message.parts[0].text)).toEqual([
      "Can a person help?",
      "I can help with that.",
      "Order 1042, please.",
      "Thanks!",
      "agent:Thanks!",
    ]);
  });

  it("answers INPUT_REQUIRED on a person's reply the caller sends past without reading it first", async () => {
    const ctx = createA2aTestApp();
    const { session, agent, publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const conversationId = await conversationIdForContext(ctx, contextId);
    const operator = operatorOf(ctx, session, conversationId);
    const takeover = await operator.takeOver();
    const waiting = await sendText(ctx, publicId, "Can a person help?", { contextId }).expect(200);
    const task = waiting.body.result.task;
    await operator.reply("I can help with that.", takeover.body.ownership.version);

    // No GetTask in between: the caller writes again while the person's reply is unread.
    const next = await sendText(ctx, publicId, "Order 1042, please.", { taskId: task.id, contextId }).expect(200);

    expect(next.body.result.task).toMatchObject({
      id: task.id,
      status: { state: "TASK_STATE_INPUT_REQUIRED", message: { role: "ROLE_AGENT", parts: [{ text: "I can help with that." }] } },
    });
    const read = await rpc(ctx, publicId, "GetTask", { id: task.id }).expect(200);
    expect(read.body.result.status).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "I can help with that." }] } });
    expect(read.body.result.history.map((message: { parts: [{ text: string }] }) => message.parts[0].text)).toEqual([
      "Can a person help?",
      "I can help with that.",
      "Order 1042, please.",
    ]);
    expect(await assistantReplies(ctx, agent.workspaceId, conversationId)).toHaveLength(1);
  });

  it("opens a task carrying a person's reply the caller has not seen, rather than dropping it", async () => {
    const ctx = createA2aTestApp();
    const { session, publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const operator = operatorOf(ctx, session, await conversationIdForContext(ctx, contextId));
    const takeover = await operator.takeOver();
    const replied = await operator.reply("A teammate here: your refund went out.", takeover.body.ownership.version);
    await operator.handBack(replied.body.ownership?.version ?? takeover.body.ownership.version);

    const next = await sendText(ctx, publicId, "Any news?", { contextId }).expect(200);

    expect(next.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(next.body.result.task.history.map((message: { parts: [{ text: string }] }) => message.parts[0].text)).toEqual([
      "A teammate here: your refund went out.",
      "Any news?",
      "agent:Any news?",
    ]);
  });
});

describe("A2A tasks: a routine waiting on an operator's approval (US3 AS-3)", () => {
  it("is WORKING while the approval waits, then INPUT_REQUIRED on read once an agent message lands after the decision", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await withRoutine(ctx, supportIntakeWithApprovalDraft());
    const started = await sendText(ctx, publicId, "I need support intake").expect(200);
    const { id, contextId } = started.body.result.task;

    const waiting = await sendText(ctx, publicId, "topic: billing", { taskId: id, contextId }, { extensions: A2A_CONVERSE_EXTENSION_URI }).expect(200);
    expect(waiting.body.result.task).toMatchObject({
      id,
      status: {
        state: "TASK_STATE_WORKING",
        message: { metadata: { [A2A_CONVERSE_EXTENSION_URI]: expect.objectContaining({ routine: expect.objectContaining({ status: "waiting_for_approval" }) }) } },
      },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "awaiting_approval" } },
    });

    // The in-memory app stubs approval decisions, so the reply the decision's resume turn stores is written directly.
    const resumed = await ctx.repositories.messageRepository.create({
      conversationId: await conversationIdForContext(ctx, contextId),
      workspaceId: agent.workspaceId,
      role: "assistant",
      source: "ai_agent",
      content: "Your intake is approved.",
    });
    const read = await rpc(ctx, publicId, "GetTask", { id }, { extensions: A2A_CONVERSE_EXTENSION_URI }).expect(200);

    expect(read.body.result).toMatchObject({
      id,
      status: { state: "TASK_STATE_INPUT_REQUIRED", message: { messageId: resumed.id, role: "ROLE_AGENT", parts: [{ text: "Your intake is approved." }] } },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "agent_message" } },
    });
    // The read keeps what the turn reported about the routine beside who owns the thread now.
    expect(read.body.result.status.message.metadata[A2A_CONVERSE_EXTENSION_URI]).toMatchObject({
      author: "agent",
      ownership: { state: "ai_owned" },
      routine: { status: "waiting_for_approval" },
    });
  });
});

describe("A2A turns: overlapping sends and shared budgets", () => {
  it("answers a send a newer message on the same context superseded with reason TURN_SUPERSEDED", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first question") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { route: "direct", framing: { isIdentityQuestion: false } };
      },
    };
    const ctx = createA2aTestApp({ turnRouter });
    const metrics = () => ctx.dependencies.metricsRegistry?.renderPrometheus() ?? "";
    const { publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.message.contextId as string;

    const first = sendText(ctx, publicId, "first question", { contextId }).then((response) => response);
    await firstStarted.promise;
    const latestSent = sendText(ctx, publicId, "latest question", { contextId }).then((response) => response);
    // The newer turn cancels the first and waits for it to finish; let it run once it has.
    await vi.waitFor(() => expect(metrics()).toContain('reason="superseded"'), { timeout: 10_000 });
    releaseFirst.resolve();
    const [superseded, latest] = await Promise.all([first, latestSent]);

    expect(superseded.status).toBe(200);
    expect(superseded.body.error).toEqual({
      code: -32000,
      message: expect.any(String),
      data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TURN_SUPERSEDED", domain: "radioso.ai", metadata: {} }],
    });
    expect(latest.status).toBe(200);
    expect(latest.body.result.message.parts).toEqual([{ text: "agent:latest question" }]);
    expect(metrics().split("\n")).toContain('radioso_a2a_requests_total{method="SendMessage",outcome="TURN_SUPERSEDED"} 1');
  });

  it("spends one per-caller turn budget across MCP and A2A for a converse grant (FR-025)", async () => {
    const ctx = createA2aTestApp({
      abuseControlRepository: new InMemoryAbuseControlRepository(),
      envOverrides: { AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 2 },
    });
    const { agent, publicId } = await openA2aAgent(ctx);
    const grant = await issueConverseGrant(ctx, agent);
    const exchange = await request(ctx.app).post("/api/v1/mcp/converse/session").send({ launchToken: grant.token }).expect(201);
    const mcpAsk = () => request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken as string}`)
      .send({ message: "Hello over MCP" });

    await mcpAsk().expect(200);
    await sendText(ctx, publicId, "Hello over A2A", {}, { bearer: grant.token }).expect(200);
    const throttledA2a = await sendText(ctx, publicId, "Hello again over A2A", {}, { bearer: grant.token });
    const throttledMcp = await mcpAsk();

    expect(throttledA2a.status).toBe(429);
    expect(Number(throttledA2a.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttledA2a.headers["ratelimit-limit"]).toBe("2");
    expect(throttledMcp.status).toBe(429);
  });
});
