import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AuditEventRepository } from "../../../src/db/repositories/auditEventRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import { HistoryItemsRepository } from "../../../src/db/repositories/historyItemsRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { ChatHistoryService } from "../../../src/modules/chat/services/chatHistoryService.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * A reply block is stored on the assistant message row (`metadata_json.blocks`) with its image
 * ids, and history builds the image addresses as it reads the row back: the round trip through
 * Postgres returns the block as the visitor saw it.
 */
describeIntegration("reply blocks on the message row (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const conversations = new ConversationRepository(database.kysely);
  const messages = new MessageRepository(database.kysely);
  const auditEvents = new AuditEventRepository(database.kysely);
  const history = new ChatHistoryService(
    conversations,
    messages,
    auditEvents,
    new HistoryItemsRepository(database.kysely),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { forImage: (imageId) => ({ src: `https://app.example/backend/api/v1/public/reply-images/${imageId}/640`, srcSet: `https://app.example/backend/api/v1/public/reply-images/${imageId}/320 320w` }) },
  );
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Reply Blocks Co",
      `reply-blocks-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Reply Blocks WS",
      `route-${workspaceId}`,
    ]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("replays the stored block from history with its addresses built on read", async () => {
    const imageId = randomUUID();
    const storedBlock = {
      type: "item_list",
      id: "b1",
      layout: "carousel",
      selection: "none",
      caption: "Two hiking guides",
      items: [{
        key: imageId,
        title: "A Field Guide to Alpine Flowers",
        image: { imageId, width: 1280, height: 960, alt: "" },
        actions: [{ type: "open", url: "https://shop.example/books/alpine-flowers" }],
      }],
    };
    const conversation = await conversations.create({ workspaceId });
    await messages.create({ conversationId: conversation.id, workspaceId, role: "user", content: "Hiking guides?" });
    const reply = await messages.create({
      conversationId: conversation.id,
      workspaceId,
      role: "assistant",
      content: "We carry a guide to alpine flowers.",
      metadata: { blocks: [storedBlock] },
    });

    const stored = await database.query<{ metadata_json: { blocks?: unknown } }>(
      "SELECT metadata_json FROM messages WHERE id = $1",
      [reply.id],
    );
    expect(stored[0]?.metadata_json.blocks).toEqual([storedBlock]);

    const detail = await history.getConversation(workspaceId, conversation.id, { limit: 50, offset: 0 });
    const replayed = detail.messages.find((message) => message.id === reply.id);

    expect(replayed?.blocks).toEqual([{
      ...storedBlock,
      items: [{
        ...storedBlock.items[0],
        image: {
          src: `https://app.example/backend/api/v1/public/reply-images/${imageId}/640`,
          srcSet: `https://app.example/backend/api/v1/public/reply-images/${imageId}/320 320w`,
          width: 1280,
          height: 960,
          alt: "",
        },
      }],
    }]);
  });
});
