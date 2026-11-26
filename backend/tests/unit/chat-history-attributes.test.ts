import { describe, expect, it, vi } from "vitest";

import type {
  ConversationAttribute,
  ConversationAttributeFilter,
  ConversationAttributeReader,
} from "../../src/modules/context-variables/public.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import {
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryHistoryItemsRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const topic: ConversationAttribute = {
  name: "topic",
  valueType: "enum",
  value: "billing",
  option: { label: "Billing", archived: false },
  redacted: false,
  scope: "conversation",
  writtenBy: { kind: "classifier", ref: "context-classification/1" },
  updatedAt: new Date("2026-11-20T10:00:00.000Z"),
  classified: true,
};

const setup = () => {
  const conversations = new InMemoryConversationRepository();
  const audit = new InMemoryAuditEventRepository();
  const resolved: ConversationAttributeFilter = { variableId: "topic-id", key: "billing" };
  const attributes = {
    read: vi.fn(async () => [topic]),
    resolveFilter: vi.fn(async () => resolved),
  } satisfies ConversationAttributeReader;
  const history = new InMemoryHistoryItemsRepository(conversations, audit);
  const service = new ChatHistoryService(
    conversations,
    new InMemoryMessageRepository(),
    audit,
    history,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, null,
    attributes,
  );
  return { conversations, history, attributes, service, resolved };
};

describe("a conversation's attributes on the history read", () => {
  it("reads them for an operator, by the conversation's own keys: its id, its chat session and its verified customer", async () => {
    const { conversations, attributes, service } = setup();
    const conversation = await conversations.create({
      workspaceId: "workspace-1", anonymousSessionId: "session-1", verifiedCustomerId: "customer-1",
    });

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 50 }, { includeAttributes: true });

    expect(detail.attributes).toEqual([topic]);
    // The channel is passed so a reader looks a person key up only where a channel keeps one.
    expect(attributes.read).toHaveBeenCalledWith("workspace-1", {
      conversationId: conversation.id, chatSessionId: "session-1", verifiedCustomerId: "customer-1", sourceChannel: null,
    });
  });

  it("reads them on the first page only: an older page leaves them out", async () => {
    const { conversations, attributes, service } = setup();
    const conversation = await conversations.create({ workspaceId: "workspace-1" });

    const older = await service.getConversation("workspace-1", conversation.id, { limit: 50, offset: 50 }, { includeAttributes: true });

    expect(older).not.toHaveProperty("attributes");
    expect(attributes.read).not.toHaveBeenCalled();
  });

  it("leaves them out of a read that does not ask, such as the visitor's own", async () => {
    const { conversations, attributes, service } = setup();
    const conversation = await conversations.create({ workspaceId: "workspace-1" });

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 50 });

    expect(detail).not.toHaveProperty("attributes");
    expect(attributes.read).not.toHaveBeenCalled();
  });
});

describe("filtering the history lists by an attribute", () => {
  it("resolves the filter as the caller names it, then hands both lists the stored value it matches", async () => {
    const { history, conversations, attributes, service, resolved } = setup();
    const listItems = vi.spyOn(history, "listPageByWorkspaceId");
    const listConversations = vi.spyOn(conversations, "listPageByWorkspaceId");

    await service.listItems("workspace-1", { limit: 20, attribute: { name: "topic", option: "billing" } });
    await service.listConversations("workspace-1", { limit: 20, attribute: { name: "topic", option: "_not_set" } });

    expect(attributes.resolveFilter).toHaveBeenNthCalledWith(1, "workspace-1", { name: "topic", option: "billing" });
    expect(attributes.resolveFilter).toHaveBeenNthCalledWith(2, "workspace-1", { name: "topic", option: "_not_set" });
    expect(listItems).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ attribute: resolved }));
    expect(listConversations).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ attribute: resolved }));
  });

  it("lists unfiltered without one, and resolves nothing", async () => {
    const { conversations, attributes, service } = setup();
    const listConversations = vi.spyOn(conversations, "listPageByWorkspaceId");

    await service.listConversations("workspace-1", { limit: 20 });

    expect(attributes.resolveFilter).not.toHaveBeenCalled();
    expect(listConversations).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ attribute: undefined }));
  });

  it("refuses a filter the attribute reader refuses, before reading either list", async () => {
    const { history, attributes, service } = setup();
    const listItems = vi.spyOn(history, "listPageByWorkspaceId");
    attributes.resolveFilter.mockRejectedValueOnce(Object.assign(new Error("No attribute is named urgency"), { statusCode: 400 }));

    await expect(service.listItems("workspace-1", { limit: 20, attribute: { name: "urgency", option: "high" } }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(listItems).not.toHaveBeenCalled();
  });
});
