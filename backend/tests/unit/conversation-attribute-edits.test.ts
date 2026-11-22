import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_ATTRIBUTE_EDITS_TOTAL,
  ConversationAttributeEditService,
  type AttributeEditActor,
  type ConversationAttributeEditReads,
} from "../../src/modules/context-variables/conversationAttributeEdits.js";
import type { ConversationAttribute, ConversationAttributeReader } from "../../src/modules/context-variables/conversationAttributes.js";
import type { ContextVariable } from "../../src/modules/context-variables/domain.js";
import { notFound } from "../../src/shared/domain/errors.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const actor: AttributeEditActor = { accountId: "account-1", userId: "user-1", surface: "inbox" };

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
  updatedAt: new Date("2026-11-22T10:00:00.000Z"),
  classified: false,
  ...overrides,
});

const harness = (options: {
  classified?: string[];
  conversationExists?: boolean;
  deleted?: boolean;
  readBack?: ConversationAttribute[];
  reclassify?: () => Promise<void>;
} = {}) => {
  const reads: ConversationAttributeEditReads = {
    findByName: async (workspace, name) => [topic, careNeed, plan].find((candidate) => workspace === workspaceId && candidate.name === name) ?? null,
    readConversationKeys: async (workspace, id) => (options.conversationExists === false || workspace !== workspaceId || id !== conversationId
      ? null
      : { conversationId, chatSessionId: "session-1", verifiedCustomerId: null }),
    readClassifiedVariableIds: async () => new Set(options.classified ?? []),
  };
  const attributes: ConversationAttributeReader = {
    read: vi.fn(async () => options.readBack ?? [attribute()]),
    resolveFilter: vi.fn(),
  };
  const values = {
    upsertValue: vi.fn(async () => null),
    deleteValue: vi.fn(async () => options.deleted ?? true),
  };
  const reclassification = { request: vi.fn(options.reclassify ?? (async () => undefined)) };
  const audit = { record: vi.fn(async () => undefined) };
  const metrics = { incrementCounter: vi.fn() };
  const logger = { warn: vi.fn() };
  const service = new ConversationAttributeEditService({ reads, attributes, values, reclassification, audit, metrics, logger });
  const outcomes = () => metrics.incrementCounter.mock.calls.map(([, options]) => (options as { labels: Record<string, string> }).labels);
  return { service, attributes, values, reclassification, audit, metrics, logger, outcomes };
};

describe("a teammate sets a conversation's attribute (#1884)", () => {
  it("writes the option for the conversation as the teammate, and reads the attribute back", async () => {
    const { service, values, outcomes } = harness();

    const result = await service.set({ workspaceId, conversationId, name: "topic", value: "billing", actor });

    expect(values.upsertValue).toHaveBeenCalledWith("topic-id", { type: "conversation", id: conversationId }, "billing", { kind: "operator", ref: "user-1" });
    expect(result).toEqual({ attribute: attribute(), classificationQueued: false });
    expect(outcomes()).toEqual([{ action: "set", outcome: "written" }]);
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
    ["one that is not a Choice", "plan", 400, "refused_type"],
  ])("refuses %s", async (_case, name, statusCode, outcome) => {
    const { service, values, audit, outcomes } = harness();

    await expect(service.set({ workspaceId, conversationId, name, value: "billing", actor })).rejects.toMatchObject({ statusCode });
    await expect(service.reset({ workspaceId, conversationId, name, actor })).rejects.toMatchObject({ statusCode });
    expect(values.upsertValue).not.toHaveBeenCalled();
    expect(values.deleteValue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([{ action: "set", outcome }, { action: "reset", outcome }]);
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
    const { service, values, reclassification, audit, outcomes } = harness({ classified: ["topic-id"], readBack: [] });

    const result = await service.reset({ workspaceId, conversationId, name: "topic", actor });

    expect(values.deleteValue).toHaveBeenCalledWith("topic-id", { type: "conversation", id: conversationId }, { kind: "operator", ref: "user-1" });
    expect(reclassification.request).toHaveBeenCalledWith({ workspaceId, conversationId });
    expect(result).toEqual({ attribute: null, classificationQueued: true });
    expect(audit.record).toHaveBeenCalledWith({ workspaceId, conversationId, variableId: "topic-id", action: "reset", actor });
    expect(outcomes()).toEqual([{ action: "reset", outcome: "cleared" }]);
  });

  it("clears the value without asking the AI when nothing on the conversation classifies it, and reads what the visitor's rungs hold", async () => {
    const inherited = attribute({ scope: "session", writtenBy: { kind: "api", ref: "credential-1" } });
    const { service, reclassification } = harness({ readBack: [inherited] });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor }))
      .resolves.toEqual({ attribute: inherited, classificationQueued: false });
    expect(reclassification.request).not.toHaveBeenCalled();
  });

  it("changes nothing, audits nothing and asks the AI nothing when the conversation holds no value of its own", async () => {
    const { service, reclassification, audit, outcomes } = harness({ classified: ["topic-id"], deleted: false, readBack: [] });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    expect(reclassification.request).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([{ action: "reset", outcome: "unchanged" }]);
  });

  it("keeps the reset when the AI's run can't be queued, says so, and logs it", async () => {
    const { service, logger } = harness({ classified: ["topic-id"], readBack: [], reclassify: async () => { throw new Error("queue unavailable"); } });

    await expect(service.reset({ workspaceId, conversationId, name: "topic", actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "conversation_attribute_reclassification_failed" }), expect.any(String));
  });

  it("counts each edit by action and outcome only", () => {
    expect(CONVERSATION_ATTRIBUTE_EDITS_TOTAL).toBe("radioso_conversation_attribute_edits_total");
  });
});
