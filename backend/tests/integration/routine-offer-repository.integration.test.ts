import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ClarificationStateRepository } from "../../src/db/repositories/clarificationStateRepository.js";
import { RoutineOfferRepository } from "../../src/db/repositories/routineOfferRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { seedConversations } from "./support/conversationSeed.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("RoutineOfferRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const offers = new RoutineOfferRepository(database.kysely);
  const clarifications = new ClarificationStateRepository(database.kysely);
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();

  beforeAll(async () => {
    await seedConversations(database, [conversationId, otherConversationId]);
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  it("remembers which routines a conversation was offered, once each, past any later clarification", async () => {
    expect(await offers.loadOffered({ sessionId: conversationId })).toEqual([]);

    await offers.record({ sessionId: conversationId, routineId: "room_booking" });
    await offers.record({ sessionId: conversationId, routineId: "room_booking" });
    await clarifications.save({
      sessionId: conversationId,
      source: "retrieval_sense",
      mode: "ask",
      candidates: [{ id: "cand-1", label: "Option one", confidence: 0.9, payload: {} }],
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await clarifications.clear({ sessionId: conversationId, outcome: "expired" });

    expect(await offers.loadOffered({ sessionId: conversationId })).toEqual(["room_booking"]);
    expect(await offers.loadOffered({ sessionId: otherConversationId })).toEqual([]);
  });

  it("forgets a conversation's offers with the conversation", async () => {
    await offers.record({ sessionId: otherConversationId, routineId: "room_booking" });

    await database.query(`DELETE FROM conversations WHERE id = $1`, [otherConversationId]);

    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM routine_offers WHERE conversation_id = $1`,
      [otherConversationId],
    );
    expect(rows[0]?.count).toBe("0");
  });
});
