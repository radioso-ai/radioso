import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { storedReplyBlockSchema, type StoredReplyBlock } from "../../src/modules/chat/contracts/replyBlocks.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A visitor's card pick (#1763) against Postgres: the rule that a reply is picked from once, read
// from the visitor messages' stored metadata, and what history reads back of the pick and of the
// card it names.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("card picks (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new MessageRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();

  const block: StoredReplyBlock = {
    type: "item_list",
    id: "b1",
    layout: "carousel",
    selection: "single",
    caption: "Boat tours",
    items: [
      {
        key: "image-lighthouse",
        title: "Lighthouse Loop",
        image: { imageId: "image-lighthouse", width: 640, height: 480, alt: "A boat by the lighthouse" },
        actions: [{ type: "open", url: "https://tours.example/lighthouse" }, { type: "select" }],
        document: { id: randomUUID(), title: "Lighthouse Loop tour" },
      },
      {
        key: "image-seals",
        title: "Seal Island Run",
        actions: [{ type: "select" }],
        document: { id: randomUUID(), title: "Seal Island tour" },
      },
    ],
  };

  const pickOf = (messageId: string, itemKey: string) => ({
    method: "item_select" as const,
    selection: { messageId, blockId: "b1", itemKey },
  });

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Pick Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Pick Workspace",
      `route-${workspaceId}`,
    ]);
    for (const id of [conversationId, otherConversationId]) {
      await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [id, workspaceId]);
    }
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])`, [[conversationId, otherConversationId]]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const cardsReply = () =>
    repository.create({ conversationId, workspaceId, role: "assistant", content: "Three tours leave every morning.", metadata: { blocks: [block] } });

  it("finds another card picked from a reply, and takes the same card again as a retry", async () => {
    const cards = await cardsReply();
    await repository.create({ conversationId, workspaceId, role: "user", content: "Lighthouse Loop", inputMetadata: pickOf(cards.id, "image-lighthouse") });

    const other = (itemKey: string) =>
      repository.hasOtherItemSelectionFrom({ workspaceId, conversationId, messageId: cards.id, itemKey });
    expect(await other("image-seals")).toBe(true);
    expect(await other("image-lighthouse")).toBe(false);
  });

  it("finds no pick in a typed message, in another conversation, or from another reply", async () => {
    const cards = await cardsReply();
    await repository.create({ conversationId, workspaceId, role: "user", content: "image-lighthouse", inputMetadata: { method: "typed" } });
    await repository.create({
      conversationId: otherConversationId,
      workspaceId,
      role: "user",
      content: "Lighthouse Loop",
      inputMetadata: pickOf(cards.id, "image-lighthouse"),
    });
    await repository.create({ conversationId, workspaceId, role: "user", content: "Lighthouse Loop", inputMetadata: pickOf(randomUUID(), "image-lighthouse") });

    expect(await repository.hasOtherItemSelectionFrom({ workspaceId, conversationId, messageId: cards.id, itemKey: "image-seals" })).toBe(false);
  });

  it("reads back the pick on the visitor's message and the card's document on the reply", async () => {
    const cards = await cardsReply();
    const pick = await repository.create({ conversationId, workspaceId, role: "user", content: "Seal Island Run", inputMetadata: pickOf(cards.id, "image-seals") });

    const thread = await repository.listByConversationId(workspaceId, conversationId);
    const visitorMessage = thread.find((message) => message.id === pick.id);
    const reply = thread.find((message) => message.id === cards.id);

    expect(visitorMessage?.inputMetadata).toMatchObject(pickOf(cards.id, "image-seals"));
    const [storedBlock] = storedReplyBlockSchema.array().parse((reply?.metadata as { blocks?: unknown }).blocks);
    expect(storedBlock?.items.map((item) => item.document)).toEqual(block.items.map((item) => item.document));
  });
});
