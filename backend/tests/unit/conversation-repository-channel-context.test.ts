import type { ConversationChannelContext } from "@radioso/conversation-contract";
import { describe, expect, it, vi } from "vitest";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";

const conversationRow = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "33333333-3333-4333-8333-333333333333",
  agent_name: "Agent",
  source_channel: "slack",
  source_origin: null,
  anonymous_session_id: null,
  channel_context: {
    provider: "slack",
    team: { id: "T1", name: "Acme" },
    channel: { id: "D1", type: "im" },
    user: { id: "U1", displayName: "Dana" },
  } as ConversationChannelContext,
  created_at: new Date("2026-06-23T12:00:00.000Z"),
  updated_at: new Date("2026-06-23T12:00:00.000Z"),
};

describe("ConversationRepository channel context", () => {
  it("writes and reads typed channel context when creating a conversation", async () => {
    const query = vi.fn(async (_text: string, _params?: unknown[]) => [conversationRow]);
    const repository = new ConversationRepository({
      query,
      queryOptional: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      withTransaction: vi.fn(),
    } as never);

    const conversation = await repository.create(
      conversationRow.workspace_id,
      conversationRow.agent_id,
      "slack",
      null,
      null,
      conversationRow.channel_context,
    );

    expect(conversation.channelContext).toEqual(conversationRow.channel_context);
    expect(query.mock.calls[0]![0]).toContain("channel_context");
    expect(query.mock.calls[0]![1]).toEqual([
      expect.any(String),
      conversationRow.workspace_id,
      conversationRow.agent_id,
      "slack",
      null,
      null,
      conversationRow.channel_context,
    ]);
  });

  it("maps missing channel context to null for existing conversations", async () => {
    const query = vi.fn(async () => [{ ...conversationRow, channel_context: null }]);
    const repository = new ConversationRepository({
      query,
      queryOptional: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      withTransaction: vi.fn(),
    } as never);

    const conversation = await repository.findByIdAndWorkspaceId(conversationRow.id, conversationRow.workspace_id);

    expect(conversation?.channelContext).toBeNull();
  });
});
