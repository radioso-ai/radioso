import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_ATTRIBUTE_EDITS_TOTAL,
  ConversationAttributeEditService,
  type AttributeEditActor,
  type ConversationAttributeEditReads,
} from "../../src/modules/context-variables/conversationAttributeEdits.js";
import type { ConversationAttribute, StoredConversationAttributeValue } from "../../src/modules/context-variables/conversationAttributes.js";
import type { ContextValueWriter, ContextVariable, ContextVariableScope, ContextVariableValue } from "../../src/modules/context-variables/domain.js";
import { notFound } from "../../src/shared/domain/errors.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const actor: AttributeEditActor = { accountId: "account-1", userId: "user-1", surface: "inbox" };
const writtenAt = new Date("2026-11-22T10:00:00.000Z");

const variable = (overrides: Partial<ContextVariable> & Pick<ContextVariable, "id" | "name">): ContextVariable => ({
  workspaceId,
  description: null,
  valueType: "enum",
  options: [
    { key: "billing", label: "Billing", description: null, archived: false },
    { key: "shipping", label: "Shipping", description: null, archived: false },
    { key: "returns", label: "Returns", description: null, archived: true },
  ],
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...overrides,
});

const topic = variable({ id: "topic-id", name: "topic" });
const careNeed = variable({ id: "care-id", name: "care_need", sensitivity: "sensitive" });
const plan = variable({ id: "plan-id", name: "plan", valueType: "string", options: null });

const attribute = (overrides: Partial<ConversationAttribute> = {}): ConversationAttribute => ({
  name: "topic",
  valueType: "enum",
  value: "billing",
  option: { label: "Billing", archived: false },
  redacted: false,
  scope: "conversation",
  writtenBy: { kind: "operator", ref: "user-1" },
  updatedAt: writtenAt,
  classified: false,
  ...overrides,
});

/** A stored value of `topic`: the conversation's own unless another scope is named. */
const topicValue = (data: string, writtenBy: ContextValueWriter, scope: ContextVariableScope = { type: "conversation", id: conversationId }): StoredConversationAttributeValue => ({
  variable: topic,
  value: { id: `value-${scope.type}`, workspaceId, variableId: topic.id, scope, data, lastModified: writtenAt, writtenBy },
});

/**
 * The edit service over in-memory ports. `held` is what the conversation's rungs hold, most specific
 * first; the value writes keep it current, so a read after a write reads what the write left.
 */
const harness = (options: {
  classified?: string[];
  conversationExists?: boolean;
  held?: StoredConversationAttributeValue[];
  reclassify?: () => Promise<void>;
} = {}) => {
  let held = [...(options.held ?? [])];
  const ownValue = () => held.find((entry) => entry.value.scope.type === "conversation");
  const reads: ConversationAttributeEditReads = {
    findByName: async (workspace, name) => [topic, careNeed, plan].find((candidate) => workspace === workspaceId && candidate.name === name) ?? null,
    readConversation: vi.fn(async (workspace: string, id: string) => (options.conversationExists === false || workspace !== workspaceId || id !== conversationId
      ? null
      : { keys: { conversationId, chatSessionId: "session-1", verifiedCustomerId: null }, classifiedVariableIds: new Set(options.classified ?? []) })),
    readMostSpecificValues: vi.fn(async () => {
      const own = ownValue();
      return own ? [own] : held.slice(0, 1);
    }),
  };
  const values = {
    upsertValue: vi.fn(async (variableId: string, scope: ContextVariableScope, data: unknown, writtenBy: ContextValueWriter): Promise<ContextVariableValue | null> => {
      const written = topicValue(data as string, writtenBy, scope);
      held = [written, ...held.filter((entry) => entry.value.scope.type !== "conversation")];
      return written.value;
    }),
    deleteValue: vi.fn(async () => {
      const had = ownValue() !== undefined;
      held = held.filter((entry) => entry.value.scope.type !== "conversation");
      return had;
    }),
  };
  const reclassification = { request: vi.fn(options.reclassify ?? (async () => undefined)) };
  const audit = { record: vi.fn(async () => undefined) };
  const metrics = { incrementCounter: vi.fn() };
  const logger = { warn: vi.fn() };
  const service = new ConversationAttributeEditService({ reads, values, reclassification, audit, metrics, logger });
  const outcomes = () => metrics.incrementCounter.mock.calls.map(([, options]) => (options as { labels: Record<string, string> }).labels);
  return { service, reads, values, reclassification, audit, metrics, logger, outcomes };
};

describe("a teammate sets a conversation's attribute (#1884)", () => {
  it("writes the option for the conversation as the teammate, and reads the attribute back", async () => {
    const { service, values, outcomes } = harness();

    const result = await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor });

    expect(values.upsertValue).toHaveBeenCalledWith("topic-id", { type: "conversation", id: conversationId }, "billing", { kind: "operator", ref: "user-1" });
    expect(result).toEqual({ attribute: attribute(), classificationQueued: false });
    expect(outcomes()).toEqual([{ action: "set", outcome: "written" }]);
  });

  it("changes nothing when a teammate already set that option: no write, no audit, outcome unchanged", async () => {
    const { service, values, audit, outcomes } = harness({ held: [topicValue("billing", { kind: "operator", ref: "user-2" })] });

    const result = await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor });

    expect(values.upsertValue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(result).toEqual({ attribute: attribute({ writtenBy: { kind: "operator", ref: "user-2" } }), classificationQueued: false });
    expect(outcomes()).toEqual([{ action: "set", outcome: "unchanged" }]);
  });

  it.each([
    ["the AI", { kind: "classifier", ref: "context-classification/1" }],
    ["an API token", { kind: "api", ref: "credential-1" }],
    ["a routine", { kind: "routine", ref: "booking:run-1" }],
  ] as const)("makes the option %s set the team's, so the AI no longer changes it, and audits that", async (_writer, writtenBy) => {
    const { service, values, audit, outcomes } = harness({ held: [topicValue("billing", writtenBy)] });

    const result = await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor });

    expect(values.upsertValue).toHaveBeenCalledWith("topic-id", { type: "conversation", id: conversationId }, "billing", { kind: "operator", ref: "user-1" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ variableId: "topic-id", action: "set" }));
    expect(result.attribute).toMatchObject({ value: "billing", writtenBy: { kind: "operator", ref: "user-1" } });
    expect(outcomes()).toEqual([{ action: "set", outcome: "pinned" }]);
  });

  it("sets the conversation's own option over a value kept for the visitor's session", async () => {
    const { service, values, outcomes } = harness({ held: [topicValue("billing", { kind: "operator", ref: "user-2" }, { type: "session", id: "session-1" })] });

    await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor });

    expect(values.upsertValue).toHaveBeenCalled();
    expect(outcomes()).toEqual([{ action: "set", outcome: "written" }]);
  });

  it("reads the conversation once per edit, and marks what its release classifies from that read", async () => {
    const { service, reads } = harness({ classified: ["topic-id"], held: [topicValue("billing", { kind: "classifier", ref: "context-classification/1" })] });

    const set = await service.set({ workspaceId, conversationId, name: "topic", value: "shipping", actor });
    const reset = await service.reset({ workspaceId, conversationId, name: "topic", actor });

    expect(set.attribute).toMatchObject({ value: "shipping", classified: true });
    expect(reset).toEqual({ attribute: null, classificationQueued: true });
    expect(reads.readConversation).toHaveBeenCalledTimes(2);
  });

  it("records a content-free audit event: the attribute's id, the conversation and the teammate, never the value", async () => {
    const { service, audit } = harness();

    await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor: { ...actor, surface: "mcp" } });

    expect(audit.record).toHaveBeenCalledWith({ workspaceId, conversationId, variableId: "topic-id", action: "set", actor: { ...actor, surface: "mcp" } });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("billing");
  });

  it("refuses an option the attribute doesn't offer, naming its active keys", async () => {
    const { service, values, outcomes } = harness();

    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "Billing", actor }))
      .rejects.toMatchObject({ statusCode: 400, message: "topic has no active option Billing; its option keys are billing, shipping" });
    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "returns", actor }))
      .rejects.toMatchObject({ statusCode: 400, message: "topic has no active option returns; its option keys are billing, shipping" });
    await expect(service.set({ workspaceId, conversationId, name: "topic", value: 7, actor }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(values.upsertValue).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([
      { action: "set", outcome: "refused_option" },
      { action: "set", outcome: "refused_option" },
      { action: "set", outcome: "refused_option" },
    ]);
  });

  it.each([
    ["an attribute nobody defined", "urgency", 404, "not_found"],
    ["a Private attribute", "care_need", 400, "refused_private"],
  ])("refuses %s", async (_case, name, statusCode, outcome) => {
    const { service, values, audit, outcomes } = harness();

    await expect(service.set({ workspaceId, conversationId, name, value: "billing", actor })).rejects.toMatchObject({ statusCode });
    await expect(service.reset({ workspaceId, conversationId, name, actor })).rejects.toMatchObject({ statusCode });
    expect(values.upsertValue).not.toHaveBeenCalled();
    expect(values.deleteValue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([{ action: "set", outcome }, { action: "reset", outcome }]);
  });

  it("sets only a Choice, and clears a value of any other type a routine or the host saved (#1884)", async () => {
    const { service, values, audit, outcomes } = harness({ held: [topicValue("4", { kind: "routine", ref: "booking:e-1@conversation-1" })] });

    await expect(service.set({ workspaceId, conversationId, name: "plan", value: "pro", actor }))
      .rejects.toMatchObject({ statusCode: 400, code: "attribute_not_editable", details: { reason: "not_choice" } });
    expect(values.upsertValue).not.toHaveBeenCalled();

    await expect(service.reset({ workspaceId, conversationId, name: "plan", actor })).resolves.toMatchObject({ classificationQueued: false });
    expect(values.deleteValue).toHaveBeenCalledWith("plan-id", { type: "conversation", id: conversationId }, { kind: "operator", ref: "user-1" });
    expect(audit.record).toHaveBeenCalledWith({ workspaceId, conversationId, variableId: "plan-id", action: "reset", actor });
    expect(outcomes()).toEqual([{ action: "set", outcome: "refused_type" }, { action: "reset", outcome: "cleared" }]);
  });

  it("names why a Private attribute is refused, with a code a client can act on", async () => {
    const { service } = harness();

    await expect(service.set({ workspaceId, conversationId, name: "care_need", value: "billing", actor }))
      .rejects.toMatchObject({ statusCode: 400, code: "attribute_not_editable", details: { reason: "private" } });
    await expect(service.set({ workspaceId, conversationId, name: "plan", value: "pro", actor }))
      .rejects.toMatchObject({ statusCode: 400, code: "attribute_not_editable", details: { reason: "not_choice" } });
  });

  it("refuses a conversation that doesn't exist with a 404", async () => {
    const { service, values } = harness({ conversationExists: false });

    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor })).rejects.toMatchObject({ statusCode: 404 });
    expect(values.upsertValue).not.toHaveBeenCalled();
    expect(values.deleteValue).not.toHaveBeenCalled();
  });

  it("counts a write that fails, and lets the failure through", async () => {
    const { service, values, outcomes } = harness();
    values.upsertValue.mockRejectedValueOnce(notFound("Conversation not found"));

    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor })).rejects.toMatchObject({ statusCode: 404 });
    values.upsertValue.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor })).rejects.toThrow("database unavailable");

    expect(outcomes()).toEqual([{ action: "set", outcome: "not_found" }, { action: "set", outcome: "failed" }]);
  });

  it("keeps a committed write when its audit event can't be recorded, and logs that", async () => {
    const { service, audit, logger } = harness();
    audit.record.mockRejectedValueOnce(new Error("audit store unavailable"));

    await expect(service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor })).resolves.toMatchObject({ attribute: attribute() });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "conversation_attribute_edit_audit_failed", action: "set" }), expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("billing");
  });
});

describe("a teammate resets a conversation's attribute (#1884)", () => {
  it("deletes the conversation's value and asks the AI to fill it now when the conversation's agent classifies it", async () => {
    const { service, values, reclassification, audit, outcomes } = harness({ classified: ["topic-id"], held: [topicValue("shipping", { kind: "operator", ref: "user-2" })] });

    const result = await service.reset({ workspaceId, conversationId, name: "topic", actor });

    expect(values.deleteValue).toHaveBeenCalledWith("topic-id", { type: "conversation", id: conversationId }, { kind: "operator", ref: "user-1" });
    expect(reclassification.request).toHaveBeenCalledWith({ workspaceId, conversationId });
    expect(result).toEqual({ attribute: null, classificationQueued: true });
    expect(audit.record).toHaveBeenCalledWith({ workspaceId, conversationId, variableId: "topic-id", action: "reset", actor });
    expect(outcomes()).toEqual([{ action: "reset", outcome: "cleared" }]);
  });

  it("clears the value without asking the AI when nothing on the conversation classifies it, and reads what the visitor's rungs hold", async () => {
    const inherited = topicValue("billing", { kind: "api", ref: "credential-1" }, { type: "session", id: "session-1" });
    const { service, reclassification } = harness({ held: [topicValue("shipping", { kind: "api", ref: "credential-1" }), inherited] });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor }))
      .resolves.toEqual({ attribute: attribute({ scope: "session", writtenBy: { kind: "api", ref: "credential-1" } }), classificationQueued: false });
    expect(reclassification.request).not.toHaveBeenCalled();
  });

  it("changes nothing, audits nothing and asks the AI nothing when the conversation holds no value of its own", async () => {
    const { service, reclassification, audit, outcomes } = harness({ classified: ["topic-id"] });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    expect(reclassification.request).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([{ action: "reset", outcome: "unchanged" }]);
  });

  it("keeps the reset when the AI's run can't be queued, says so, and logs it", async () => {
    const { service, logger } = harness({ classified: ["topic-id"], held: [topicValue("shipping", { kind: "operator", ref: "user-2" })], reclassify: async () => { throw new Error("queue unavailable"); } });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "conversation_attribute_reclassification_failed" }), expect.any(String));
  });

  it("counts each edit by action and outcome only", () => {
    expect(CONVERSATION_ATTRIBUTE_EDITS_TOTAL).toBe("radioso_conversation_attribute_edits_total");
  });
});
