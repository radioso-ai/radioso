import { describe, expect, it, vi } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import type { ConversationIngestInput } from "../../../src/modules/chat/contracts/index.js";
import {
  ConversationIngestService,
  type ConversationIngestScope,
  type ConversationIngestUnitOfWork,
} from "../../../src/modules/chat/services/conversationIngestService.js";
import { ConversationOwnershipService } from "../../../src/modules/handoff/public.js";
import {
  InMemoryConversationActivityStore,
  InMemoryConversationOwnershipRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../../support/fakes.js";

const workspaceId = "workspace-1";
const conversationId = "5b7f0c4e-0d55-4c43-9d3e-6f3a1d2b8c01";
const firstMessageId = "0e9b8a7c-6d5e-4f3a-8b2c-1d0e9f8a7b61";
const secondMessageId = "0e9b8a7c-6d5e-4f3a-8b2c-1d0e9f8a7b62";
const receivedAt = new Date("2026-10-01T09:30:00.000Z");

const emailContext = {
  provider: "email",
  mailbox: { id: "8a6c1f0e-3f7e-4d55-9a7a-0f6c1e2b3d4a", address: "support@customer.example" },
  threadKey: "5b0e7d2c-91a4-4b8e-8f3e-2c7d6a1b9e05",
  participant: { address: "person@example.org" },
} satisfies ConversationChannelContext;

const newConversation = (overrides: Partial<ConversationIngestInput> = {}): ConversationIngestInput => ({
  workspaceId,
  agentId: "agent-1",
  conversation: { kind: "new", conversationId, sourceChannel: "email", channelContext: emailContext },
  message: { id: firstMessageId, text: "Where is my order?", receivedAt },
  humanOwnership: null,
  ...overrides,
});

const createHarness = () => {
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const ownership = new InMemoryConversationOwnershipRepository();
  const activity = new InMemoryConversationActivityStore();
  // Every step in order, so a test can assert what happens inside the unit of work and what after.
  const steps: string[] = [];
  const scope: ConversationIngestScope = {
    conversations: {
      createIfAbsent: async (input) => {
        steps.push("create_conversation_if_absent");
        return conversations.createIfAbsent(input);
      },
      lockForUpdate: async (id, inWorkspace) => {
        steps.push("lock_conversation");
        return (await conversations.findByIdAndWorkspaceId(id, inWorkspace)) !== null;
      },
      touch: async (id, inWorkspace) => {
        steps.push("touch_conversation");
        await conversations.touch(id, inWorkspace);
      },
    },
    messages: {
      findByIdAndWorkspaceId: (inWorkspace, id) => messages.findByIdAndWorkspaceId(inWorkspace, id),
      create: async (input) => {
        steps.push("create_message");
        return messages.create(input);
      },
    },
    ownership: {
      requestHandoff: async (input) => {
        steps.push("request_handoff");
        return ownership.requestHandoff(input);
      },
      loadForUpdate: async (id) => {
        steps.push("lock_ownership");
        return ownership.loadForUpdate(id);
      },
    },
    activity: {
      record: vi.fn(async (event) => {
        steps.push(`activity:${event.kind}`);
        await activity.record(undefined, event);
      }),
    },
  };
  const unitOfWork: ConversationIngestUnitOfWork = {
    async run(work) {
      steps.push("begin");
      const result = await work(scope);
      steps.push("commit");
      return result;
    },
  };
  // The real rule for handing a conversation to a person; it needs none of the service's other collaborators.
  const ownershipService = new ConversationOwnershipService({} as ConstructorParameters<typeof ConversationOwnershipService>[0]);
  const requestHumanOwnership = vi.spyOn(ownershipService, "requestHumanOwnership");
  const publisher = {
    enqueue: vi.fn((_workspaceId: string, changeKinds: readonly string[]) => {
      steps.push(`publish:${changeKinds.join(",")}`);
      return { accepted: true as const, coalesced: false };
    }),
  };
  const service = new ConversationIngestService({ unitOfWork, ownership: ownershipService, publisher });
  return { service, conversations, messages, ownership, activity, steps, scope, requestHumanOwnership, publisher };
};

describe("ConversationIngestService", () => {
  it("records a new conversation and the customer's message under the caller's ids, in one unit of work", async () => {
    const { service, conversations, messages, steps } = createHarness();

    const result = await service.ingest(newConversation());

    expect(result).toEqual({
      conversationId,
      messageId: firstMessageId,
      conversationCreated: true,
      messageCreated: true,
      ownership: { state: "ai_owned", version: 0 },
    });
    // One unit of work holding the whole record: nothing else is written, no turn runs and no usage
    // is reserved — the service has no chat or usage collaborator to call.
    expect(steps).toEqual([
      "begin",
      "create_conversation_if_absent",
      "lock_conversation",
      "create_message",
      "touch_conversation",
      "lock_ownership",
      "commit",
      "publish:conversation.created,conversation.turn_committed",
    ]);
    expect(conversations.items.get(conversationId)).toMatchObject({
      workspaceId,
      agentId: "agent-1",
      sourceChannel: "email",
      callerKind: "human",
      channelContext: emailContext,
      purpose: "production",
      anonymousSessionId: null,
      visitorId: null,
      verifiedCustomerId: null,
    });
    expect(messages.items.get(conversationId)).toEqual([
      expect.objectContaining({
        id: firstMessageId,
        workspaceId,
        role: "user",
        source: "customer",
        content: "Where is my order?",
        metadata: { receivedAt: receivedAt.toISOString() },
      }),
    ]);
  });

  it("records nothing twice when retried with the same ids", async () => {
    const { service, messages, activity, publisher } = createHarness();
    const input = newConversation({ humanOwnership: { reason: "operator_only_mailbox" } });

    await service.ingest(input);
    const retried = await service.ingest(input);

    expect(retried).toEqual({
      conversationId,
      messageId: firstMessageId,
      conversationCreated: false,
      messageCreated: false,
      ownership: { state: "human_owned", version: 1 },
    });
    expect(messages.items.get(conversationId)).toHaveLength(1);
    expect(activity.items.map((item) => item.kind)).toEqual(["handoff_requested"]);
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
  });

  it("leaves a conversation that already exists as it is when asked to create it, and still records the new message", async () => {
    const { service, conversations, messages } = createHarness();
    await service.ingest(newConversation());
    const before = { ...conversations.items.get(conversationId)! };

    const result = await service.ingest(newConversation({
      agentId: "agent-2",
      conversation: {
        kind: "new",
        conversationId,
        sourceChannel: "web",
        channelContext: { provider: "web", origin: "https://elsewhere.example" },
      },
      message: { id: secondMessageId, text: "Any news?", receivedAt },
    }));

    expect(result).toMatchObject({ conversationCreated: false, messageCreated: true });
    expect(conversations.items.get(conversationId)).toMatchObject({
      agentId: before.agentId,
      sourceChannel: before.sourceChannel,
      channelContext: before.channelContext,
    });
    expect(messages.items.get(conversationId)?.map((message) => message.id)).toEqual([firstMessageId, secondMessageId]);
  });

  it("continues an existing conversation, and refuses one that is not in the workspace", async () => {
    const { service, messages } = createHarness();
    await service.ingest(newConversation());

    const continued = await service.ingest(newConversation({
      conversation: { kind: "existing", conversationId },
      message: { id: secondMessageId, text: "Any news?", receivedAt },
    }));

    expect(continued).toMatchObject({ conversationCreated: false, messageCreated: true });
    await expect(service.ingest(newConversation({
      workspaceId: "workspace-other",
      conversation: { kind: "existing", conversationId },
      message: { id: "0e9b8a7c-6d5e-4f3a-8b2c-1d0e9f8a7b63", text: "Hello?", receivedAt },
    }))).rejects.toMatchObject({ statusCode: 404 });
    expect(messages.items.get(conversationId)).toHaveLength(2);
  });

  it("refuses a message id already recorded in another conversation", async () => {
    const { service } = createHarness();
    await service.ingest(newConversation());

    await expect(service.ingest(newConversation({
      conversation: {
        kind: "new",
        conversationId: "5b7f0c4e-0d55-4c43-9d3e-6f3a1d2b8c02",
        sourceChannel: "email",
        channelContext: emailContext,
      },
    }))).rejects.toMatchObject({ statusCode: 409, code: "message_id_conflict" });
  });

  it("hands an AI-owned conversation to a person through requestHumanOwnership, in the same scope", async () => {
    const { service, scope, steps, requestHumanOwnership, publisher } = createHarness();

    const result = await service.ingest(newConversation({ humanOwnership: { reason: "operator_only_mailbox" } }));

    expect(result.ownership).toEqual({ state: "human_owned", version: 1 });
    expect(requestHumanOwnership).toHaveBeenCalledWith(scope, {
      conversationId,
      workspaceId,
      reason: "operator_only_mailbox",
    });
    expect(steps.slice(steps.indexOf("begin"), steps.indexOf("commit") + 1)).toEqual([
      "begin",
      "create_conversation_if_absent",
      "lock_conversation",
      "create_message",
      "touch_conversation",
      "request_handoff",
      "activity:handoff_requested",
      "commit",
    ]);
    expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, [
      "conversation.created",
      "conversation.turn_committed",
      "conversation.ownership_changed",
    ]);
  });

  it("leaves a conversation a person already owns as it is", async () => {
    const { service, ownership, activity, publisher } = createHarness();
    await service.ingest(newConversation());
    await ownership.takeOver({
      conversationId,
      workspaceId,
      accountId: "account-1",
      userId: "user-dana",
      displayName: "Dana Scully",
    });

    const result = await service.ingest(newConversation({
      conversation: { kind: "existing", conversationId },
      message: { id: secondMessageId, text: "Any news?", receivedAt },
      humanOwnership: { reason: "operator_only_mailbox" },
    }));

    expect(result.ownership).toEqual({ state: "human_owned", version: 1 });
    await expect(ownership.load(conversationId)).resolves.toMatchObject({ ownerUserId: "user-dana" });
    expect(activity.items).toEqual([]);
    expect(publisher.enqueue).toHaveBeenLastCalledWith(workspaceId, ["conversation.turn_committed"]);
  });

  it("reports the ownership as it stands when no handoff is asked for", async () => {
    const { service, ownership, requestHumanOwnership } = createHarness();
    await service.ingest(newConversation({ humanOwnership: { reason: "operator_only_mailbox" } }));

    const result = await service.ingest(newConversation({
      conversation: { kind: "existing", conversationId },
      message: { id: secondMessageId, text: "Any news?", receivedAt },
    }));

    expect(result.ownership).toEqual({ state: "human_owned", version: 1 });
    expect(requestHumanOwnership).toHaveBeenCalledTimes(1);
    await expect(ownership.load(conversationId)).resolves.toMatchObject({ reason: "operator_only_mailbox" });
  });

  it("tells nobody when the unit of work fails", async () => {
    const { service, scope, publisher } = createHarness();
    vi.mocked(scope.activity.record).mockRejectedValueOnce(new Error("activity unavailable"));

    await expect(service.ingest(newConversation({ humanOwnership: { reason: "operator_only_mailbox" } })))
      .rejects.toThrow("activity unavailable");
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });
});
