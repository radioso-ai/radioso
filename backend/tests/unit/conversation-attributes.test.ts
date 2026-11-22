import { describe, expect, it } from "vitest";

import {
  ConversationAttributeService,
  type ConversationAttributeReadPort,
  type StoredConversationAttributeValue,
} from "../../src/modules/context-variables/conversationAttributes.js";
import type {
  ContextValueWriter,
  ContextVariable,
  ContextVariableScope,
} from "../../src/modules/context-variables/domain.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

const variable = (overrides: Partial<ContextVariable> & Pick<ContextVariable, "id" | "name">): ContextVariable => ({
  workspaceId,
  description: null,
  valueType: "string",
  options: null,
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...overrides,
});

const topic = variable({
  id: "topic-id",
  name: "topic",
  valueType: "enum",
  options: [
    { key: "billing", label: "Billing", description: null, archived: false },
    { key: "shipping", label: "Shipping", description: null, archived: true },
  ],
});
const plan = variable({ id: "plan-id", name: "plan" });
const careNeed = variable({
  id: "care-id",
  name: "care_need",
  valueType: "enum",
  sensitivity: "sensitive",
  options: [{ key: "dental", label: "Dental", description: null, archived: false }],
});
const cart = variable({ id: "cart-id", name: "cart", valueType: "json" });

const stored = (
  definition: ContextVariable,
  scope: ContextVariableScope,
  data: unknown,
  writtenBy: ContextValueWriter = { kind: "api", ref: "credential-1" },
  lastModified = new Date("2026-11-20T10:00:00.000Z"),
): StoredConversationAttributeValue => ({
  variable: definition,
  value: { id: `${definition.id}-${scope.type}`, workspaceId, variableId: definition.id, scope, data, lastModified, writtenBy },
});

const serviceOver = (
  values: StoredConversationAttributeValue[],
  definitions: ContextVariable[] = [],
): ConversationAttributeService => {
  const reads: ConversationAttributeReadPort = {
    readConversationValues: async (input) => (input.workspaceId === workspaceId && input.conversationId === conversationId ? values : []),
    findByName: async (workspace, name) =>
      definitions.find((definition) => definition.workspaceId === workspace && definition.name === name) ?? null,
  };
  return new ConversationAttributeService(reads);
};

describe("a conversation's attributes", () => {
  it("shows each attribute's most specific value — the conversation's, then the visitor's session, then the customer — in name order", async () => {
    const service = serviceOver([
      stored(topic, { type: "customer", id: "customer-1" }, "shipping"),
      stored(topic, { type: "conversation", id: conversationId }, "billing", { kind: "classifier", ref: "context-classification/1" }),
      stored(plan, { type: "customer", id: "customer-1" }, "pro"),
      stored(plan, { type: "session", id: "session-1" }, "basic", { kind: "operator", ref: "user-1" }),
    ]);

    await expect(service.read(workspaceId, conversationId)).resolves.toEqual([
      {
        name: "plan",
        valueType: "string",
        value: "basic",
        redacted: false,
        scope: "session",
        writtenBy: { kind: "operator", ref: "user-1" },
        updatedAt: new Date("2026-11-20T10:00:00.000Z"),
      },
      {
        name: "topic",
        valueType: "enum",
        value: "billing",
        option: { label: "Billing", archived: false },
        redacted: false,
        scope: "conversation",
        writtenBy: { kind: "classifier", ref: "context-classification/1" },
        updatedAt: new Date("2026-11-20T10:00:00.000Z"),
      },
    ]);
  });

  it("names an archived option by its label and marks it archived, and gives a key no option names without one", async () => {
    const orphan = variable({ ...topic, id: "orphan-id", name: "orphan" });
    const service = serviceOver([
      stored(topic, { type: "conversation", id: conversationId }, "shipping"),
      stored(orphan, { type: "conversation", id: conversationId }, "returns"),
    ]);

    const attributes = await service.read(workspaceId, conversationId);

    expect(attributes.find((attribute) => attribute.name === "topic")).toMatchObject({
      value: "shipping",
      option: { label: "Shipping", archived: true },
    });
    const unnamed = attributes.find((attribute) => attribute.name === "orphan");
    expect(unnamed).toMatchObject({ value: "returns" });
    expect(unnamed).not.toHaveProperty("option");
  });

  it("redacts a Private value and its option, and keeps who set it", async () => {
    const service = serviceOver([
      stored(careNeed, { type: "conversation", id: conversationId }, "dental", { kind: "operator", ref: "user-1" }),
    ]);

    const [attribute] = await service.read(workspaceId, conversationId);

    expect(attribute).toEqual({
      name: "care_need",
      valueType: "enum",
      value: null,
      redacted: true,
      scope: "conversation",
      writtenBy: { kind: "operator", ref: "user-1" },
      updatedAt: new Date("2026-11-20T10:00:00.000Z"),
    });
  });

  it("shows a JSON value as stored", async () => {
    const service = serviceOver([stored(cart, { type: "session", id: "session-1" }, { items: 2 })]);

    await expect(service.read(workspaceId, conversationId)).resolves.toMatchObject([{ name: "cart", value: { items: 2 } }]);
  });

  it("has none for a conversation with no stored values", async () => {
    await expect(serviceOver([]).read(workspaceId, conversationId)).resolves.toEqual([]);
  });
});

describe("filtering conversations by an attribute", () => {
  const definitions = [topic, plan, careNeed];

  it("resolves a Choice attribute's name and option key, an archived option included", async () => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, { name: "topic", option: "billing" })).resolves.toEqual({ variableId: "topic-id", key: "billing" });
    await expect(service.resolveFilter(workspaceId, { name: "topic", option: "shipping" })).resolves.toEqual({ variableId: "topic-id", key: "shipping" });
  });

  it.each([
    ["an attribute nobody defined", { name: "urgency", option: "high" }, "No attribute is named urgency"],
    ["one that is not a Choice", { name: "plan", option: "pro" }, "Only a Choice attribute filters conversations; plan is not one"],
    ["a Private one", { name: "care_need", option: "dental" }, "A Private attribute does not filter conversations"],
    ["an option the attribute does not have", { name: "topic", option: "returns" }, "topic has no option returns"],
  ])("refuses %s with a 400", async (_case, filter, message) => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, filter)).rejects.toMatchObject({ statusCode: 400, message });
  });
});
