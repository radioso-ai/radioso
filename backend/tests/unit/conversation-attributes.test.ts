import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_FILTER_NOT_SET,
  ConversationAttributeService,
  type ConversationAttributeReadPort,
  type StoredConversationAttributeValue,
} from "../../src/modules/context-variables/conversationAttributes.js";
import {
  CONTEXT_VARIABLE_OPTION_KEY_PATTERN,
} from "../../src/modules/context-variables/optionSchema.js";
import {
  contextScopeLadder,
  type ContextValueWriter,
  type ContextVariable,
  type ConversationScope,
} from "../../src/modules/context-variables/domain.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const keys = { conversationId, chatSessionId: "session-1", verifiedCustomerId: "customer-1" };

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
  scope: ConversationScope,
  data: unknown,
  writtenBy: ContextValueWriter = { kind: "api", ref: "credential-1" },
  lastModified = new Date("2026-11-20T10:00:00.000Z"),
): StoredConversationAttributeValue => ({
  variable: definition,
  value: { id: `${definition.id}-${scope.type}`, workspaceId, variableId: definition.id, scope, data, lastModified, writtenBy },
});

/** The read port over `values`, which it hands back as each variable's most specific value; records the rungs it was asked for. */
const serviceOver = (
  values: StoredConversationAttributeValue[],
  definitions: ContextVariable[] = [],
  classifiedIds: string[] = [],
) => {
  const asked: Array<readonly ConversationScope[]> = [];
  const reads: ConversationAttributeReadPort = {
    readMostSpecificValues: async (workspace, scopes) => {
      asked.push(scopes);
      return workspace === workspaceId ? values : [];
    },
    readClassifiedVariableIds: async (workspace, conversation) =>
      new Set(workspace === workspaceId && conversation === conversationId ? classifiedIds : []),
    findByName: async (workspace, name) =>
      definitions.find((definition) => definition.workspaceId === workspace && definition.name === name) ?? null,
    readChannelPersonKey: async () => null,
  };
  return Object.assign(new ConversationAttributeService(reads), { asked });
};

describe("a conversation's attributes", () => {
  it("reads the conversation's own rungs of the ladder the agent resolves by, most specific first, and leaves its defaults out", async () => {
    const service = serviceOver([]);

    await service.read(workspaceId, keys);

    expect(service.asked).toEqual([
      contextScopeLadder({ ...keys, agentId: "agent-1", workspaceId }).filter((scope) => scope.type !== "agent" && scope.type !== "workspace"),
    ]);
  });

  it("reads only the rungs the conversation has: no session or customer rung without their keys", async () => {
    const service = serviceOver([]);

    await service.read(workspaceId, { conversationId, chatSessionId: null, verifiedCustomerId: null });

    expect(service.asked).toEqual([[{ type: "conversation", id: conversationId }]]);
  });

  it("shows each attribute's value, where it is kept and who set it, in name order", async () => {
    const service = serviceOver([
      stored(topic, { type: "conversation", id: conversationId }, "billing", { kind: "classifier", ref: "context-classification/1" }),
      stored(plan, { type: "session", id: "session-1" }, "basic", { kind: "operator", ref: "user-1" }),
    ]);

    await expect(service.read(workspaceId, keys)).resolves.toEqual([
      {
        name: "plan",
        valueType: "string",
        value: "basic",
        redacted: false,
        scope: "session",
        writtenBy: { kind: "operator", ref: "user-1" },
        updatedAt: new Date("2026-11-20T10:00:00.000Z"),
        classified: false,
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
        classified: false,
      },
    ]);
  });

  it("names an archived option by its label and marks it archived, and gives a key no option names without one", async () => {
    const orphan = variable({ ...topic, id: "orphan-id", name: "orphan" });
    const service = serviceOver([
      stored(topic, { type: "conversation", id: conversationId }, "shipping"),
      stored(orphan, { type: "conversation", id: conversationId }, "returns"),
    ]);

    const attributes = await service.read(workspaceId, keys);

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

    const [attribute] = await service.read(workspaceId, keys);

    expect(attribute).toEqual({
      name: "care_need",
      valueType: "enum",
      value: null,
      redacted: true,
      scope: "conversation",
      writtenBy: { kind: "operator", ref: "user-1" },
      updatedAt: new Date("2026-11-20T10:00:00.000Z"),
      classified: false,
    });
  });

  it("shows a JSON value as stored", async () => {
    const service = serviceOver([stored(cart, { type: "session", id: "session-1" }, { items: 2 })]);

    await expect(service.read(workspaceId, keys)).resolves.toMatchObject([{ name: "cart", value: { items: 2 } }]);
  });

  it("says which attributes the AI fills on this conversation, from the release the conversation runs", async () => {
    const service = serviceOver([
      stored(topic, { type: "conversation", id: conversationId }, "billing", { kind: "operator", ref: "user-1" }),
      stored(plan, { type: "session", id: "session-1" }, "basic"),
    ], [], ["topic-id"]);

    const attributes = await service.read(workspaceId, keys);

    expect(attributes.map((attribute) => [attribute.name, attribute.classified])).toEqual([["plan", false], ["topic", true]]);
  });

  it("has none for a conversation with no stored values", async () => {
    await expect(serviceOver([]).read(workspaceId, keys)).resolves.toEqual([]);
  });
});

describe("filtering conversations by an attribute", () => {
  const definitions = [topic, plan, careNeed];

  it("resolves a Choice attribute's name and option key, an archived option included", async () => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, { name: "topic", option: "billing" })).resolves.toEqual({ variableId: "topic-id", key: "billing" });
    await expect(service.resolveFilter(workspaceId, { name: "topic", option: "shipping" })).resolves.toEqual({ variableId: "topic-id", key: "shipping" });
  });

  it("resolves Not set to the attribute with no key, for conversations that hold no value of it", async () => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, { name: "topic", option: ATTRIBUTE_FILTER_NOT_SET }))
      .resolves.toEqual({ variableId: "topic-id", key: null });
  });

  it("names Not set by a word no option key can be", () => {
    expect(CONTEXT_VARIABLE_OPTION_KEY_PATTERN.test(ATTRIBUTE_FILTER_NOT_SET)).toBe(false);
  });

  it("matches the attribute's name exactly, as it is stored", async () => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, { name: " topic", option: "billing" }))
      .rejects.toMatchObject({ statusCode: 400, message: "No attribute is named  topic" });
  });

  it.each([
    ["an attribute nobody defined", { name: "urgency", option: "high" }, "No attribute is named urgency"],
    ["one that is not a Choice", { name: "plan", option: "pro" }, "Only a Choice attribute filters conversations; plan is not one"],
    ["a Private one", { name: "care_need", option: "dental" }, "A Private attribute does not filter conversations"],
    ["Not set on a Private one", { name: "care_need", option: ATTRIBUTE_FILTER_NOT_SET }, "A Private attribute does not filter conversations"],
    ["Not set on one that is not a Choice", { name: "plan", option: ATTRIBUTE_FILTER_NOT_SET }, "Only a Choice attribute filters conversations; plan is not one"],
    ["an option the attribute does not have", { name: "topic", option: "returns" }, `topic has no option returns; its option keys are billing, shipping, ${ATTRIBUTE_FILTER_NOT_SET}`],
    ["an option label instead of its key", { name: "topic", option: "Billing" }, `topic has no option Billing; its option keys are billing, shipping, ${ATTRIBUTE_FILTER_NOT_SET}`],
  ])("refuses %s with a 400", async (_case, filter, message) => {
    const service = serviceOver([], definitions);

    await expect(service.resolveFilter(workspaceId, filter)).rejects.toMatchObject({ statusCode: 400, message });
  });
});
