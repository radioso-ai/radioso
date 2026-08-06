import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NotifyExecutor } from "../../src/modules/notify/notifyExecutor.js";

const skill = {
  id: "skill_1",
  workspaceId: "ws_1",
  agentId: "agent_1",
  skillName: "contact_human",
  kind: "notify" as const,
  targetType: "notify_delivery",
  targetId: null,
  config: {},
  invocationMode: "routine_named" as const,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const hash = (payload: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// The real routine dispatcher only supplies workspaceId/agentId/sessionId →
// conversationId in the invocation context (see RoutineSkillExecutorDispatcher).
// It never injects a requestId, so the idempotency key must be derived from the
// conversation + payload, not a caller-supplied request id.
const dispatcherContext = (conversationId: string) => ({
  workspaceId: "ws_1",
  agentId: "agent_1",
  sessionId: conversationId,
  conversationId,
});

// The routine dispatcher (the only production caller) always threads the
// originating TurnContext through as `context.turn` (see
// RoutineSkillExecutorDispatcher), so `turn.inputEvent.id` — the persisted id
// of the inbound message that triggered this turn — is available as a stable
// per-invocation identity.
const dispatcherContextWithTurn = (conversationId: string, messageId: string) => ({
  ...dispatcherContext(conversationId),
  turn: {
    sessionId: conversationId,
    agent: { id: "agent_1" },
    inputEvent: { id: messageId, kind: "message", content: "contact me" },
    history: [],
    stagedContext: [],
    steering: [],
  },
});

describe("NotifyExecutor", () => {
  it("enqueues the contact.send action scoped to the conversation and payload", async () => {
    const enqueue = vi.fn(async () => ({ id: "action_1", duplicate: false }));
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });

    const collected = { message: "Please call me", email: "visitor@example.com" };
    const result = await executor.dispatch({
      skill: { name: "contact_human" },
      collected,
      context: dispatcherContext("conv_1"),
      emit: { emitStatus: async () => undefined, emitCustom: async () => undefined },
    });

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "delivered" },
    });
    const payload = { message: "Please call me", email: "visitor@example.com" };
    expect(enqueue).toHaveBeenCalledWith({
      type: "contact.send",
      payload,
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: `notify:conv_1:contact_human:${hash(payload)}`,
      skillName: "contact_human",
    });
  });

  it("records the firing skill's name on the enqueued action, distinct from the payload", async () => {
    const enqueue = vi.fn(async (_input: {
      payload: Record<string, unknown>;
      skillName?: string | null;
    }) => ({ id: "action_1", duplicate: false }));
    const namedSkill = { ...skill, skillName: "contact_sales" };
    const executor = new NotifyExecutor({
      skills: { findByName: async () => namedSkill },
      outbox: { enqueue },
    });

    await executor.dispatch({
      skill: { name: "contact_sales" },
      collected: { message: "Please call me" },
      context: dispatcherContext("conv_1"),
      emit: { emitStatus: async () => undefined, emitCustom: async () => undefined },
    });

    const [[enqueued]] = enqueue.mock.calls;
    expect(enqueued.skillName).toBe("contact_sales");
    // Routing provenance, not domain data — the payload stays message/email-shaped.
    expect(enqueued.payload).not.toHaveProperty("skillName");
  });

  it("does not collapse distinct contact requests across conversations or messages", async () => {
    const keys: string[] = [];
    const enqueue = vi.fn(async (input: { idempotencyKey?: string | null }) => {
      if (input.idempotencyKey) keys.push(input.idempotencyKey);
      return { id: "action", duplicate: false };
    });
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });
    const emit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

    // Same message, two different conversations → distinct keys (no cross-conversation drop).
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Call me" },
      context: dispatcherContext("conv_a"),
      emit,
    });
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Call me" },
      context: dispatcherContext("conv_b"),
      emit,
    });
    // Different message, same conversation → distinct key (no same-conversation drop).
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Different message" },
      context: dispatcherContext("conv_a"),
      emit,
    });
    // Identical request (same conversation + payload) → same key, so a retried turn dedupes.
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Call me" },
      context: dispatcherContext("conv_a"),
      emit,
    });

    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it("keys idempotency on the inbound message id when the dispatcher supplies a turn, so two distinct submissions with byte-identical payloads in the same conversation both enqueue", async () => {
    const keys: string[] = [];
    const enqueue = vi.fn(async (input: { idempotencyKey?: string | null }) => {
      if (input.idempotencyKey) keys.push(input.idempotencyKey);
      return { id: "action", duplicate: false };
    });
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });
    const emit = { emitStatus: async () => undefined, emitCustom: async () => undefined };
    const payload = { message: "Call me", email: "visitor@example.com" };

    // Two genuinely distinct submissions (different inbound messages), byte-identical
    // payload, same conversation — must not collide even though content-addressing
    // the payload alone would.
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: payload,
      context: dispatcherContextWithTurn("conv_a", "msg_1"),
      emit,
    });
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: payload,
      context: dispatcherContextWithTurn("conv_a", "msg_2"),
      emit,
    });
    // A retried dispatch of the SAME message still dedupes to the same key.
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: payload,
      context: dispatcherContextWithTurn("conv_a", "msg_1"),
      emit,
    });

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    // Both discriminators are present: the message id separates distinct
    // submissions, the payload hash separates distinct payloads within one turn.
    expect(keys[0]).toContain("msg_1");
    expect(keys[0]).toContain(hash(payload));
  });

  it("does not collide when one turn dispatches the same skill twice with different payloads", async () => {
    const keys: string[] = [];
    const enqueue = vi.fn(async (input: { idempotencyKey?: string | null }) => {
      if (input.idempotencyKey) keys.push(input.idempotencyKey);
      return { id: "action", duplicate: false };
    });
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });
    const emit = { emitStatus: async () => undefined, emitCustom: async () => undefined };
    // The routine runner walks consecutive skill/action steps within a single
    // turn, so two tool steps share one inputEvent.id. Keyed on the message id
    // alone these would collide and the second request would be dropped.
    const context = dispatcherContextWithTurn("conv_a", "msg_1");

    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "First request", email: "visitor@example.com" },
      context,
      emit,
    });
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Second, different request", email: "visitor@example.com" },
      context,
      emit,
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("falls back to hashing the payload when no turn is supplied (unchanged legacy behavior)", async () => {
    const enqueue = vi.fn(async () => ({ id: "action_1", duplicate: false }));
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });

    const payload = { message: "Please call me", email: "visitor@example.com" };
    await executor.dispatch({
      skill: { name: "contact_human" },
      collected: payload,
      context: dispatcherContext("conv_1"),
      emit: { emitStatus: async () => undefined, emitCustom: async () => undefined },
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `notify:conv_1:contact_human:${hash(payload)}` }),
    );
  });
});
