import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { VisitorRepository } from "../../src/db/repositories/visitorRepository.js";
import { VisitorResolver } from "../../src/modules/visitors/services/visitorResolver.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Runtime identity-resolution behavior against real Postgres — the unique partial
// indexes and the ON CONFLICT DO NOTHING + re-select path in VisitorRepository are the
// part a mocked repository (tests/unit/visitor-resolver.test.ts) cannot exercise.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("VisitorResolver (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const resolver = new VisitorResolver(new VisitorRepository(database.kysely));
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Visitor Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Visitor Workspace",
      `route-${workspaceId}`,
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("resolves two concurrent brand-new-anonymous-id conversations to exactly one visitor row (User Story 2 scenario 4)", async () => {
    const visitorKey = `anon-concurrent-${randomUUID()}`;
    const observed = { country: null, language: null, userAgent: null };

    const [first, second] = await Promise.all([
      resolver.resolveForConversation({ workspaceId, visitorKey, verifiedCustomerId: null, observed }),
      resolver.resolveForConversation({ workspaceId, visitorKey, verifiedCustomerId: null, observed }),
    ]);

    expect(first.visitorId).toBe(second.visitorId);

    const rows = await database.query<{ id: string; conversation_count: number }>(
      "SELECT id, conversation_count FROM visitors WHERE workspace_id = $1 AND visitor_key = $2",
      [workspaceId, visitorKey],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].conversation_count)).toBe(2);
  });

  it("upgrades an anonymous-only visitor in place, then a later different verified id moves the conversation without re-attaching", async () => {
    const visitorKey = `anon-story2-${randomUUID()}`;
    await resolver.resolveForConversation({
      workspaceId,
      visitorKey,
      verifiedCustomerId: null,
      observed: { country: null, language: null, userAgent: null },
    });

    const conversationId = randomUUID();
    const [anonRow] = await database.query<{ id: string }>(
      "SELECT id FROM visitors WHERE workspace_id = $1 AND visitor_key = $2",
      [workspaceId, visitorKey],
    );

    const upgraded = await resolver.attachVerifiedIdentity({
      conversationId,
      workspaceId,
      visitorKey,
      verifiedCustomerId: "customer-story2-c",
    });
    expect(upgraded.outcome).toBe("upgraded");
    const [afterUpgrade] = await database.query<{ id: string; verified_customer_id: string | null }>(
      "SELECT id, verified_customer_id FROM visitors WHERE id = $1",
      [anonRow.id],
    );
    expect(afterUpgrade.verified_customer_id).toBe("customer-story2-c");

    const moved = await resolver.attachVerifiedIdentity({
      conversationId,
      workspaceId,
      visitorKey,
      verifiedCustomerId: "customer-story2-d",
    });
    expect(moved.outcome).toBe("moved_new");

    const [stillC] = await database.query<{ verified_customer_id: string | null }>(
      "SELECT verified_customer_id FROM visitors WHERE id = $1",
      [anonRow.id],
    );
    expect(stillC.verified_customer_id).toBe("customer-story2-c");

    const [dRow] = await database.query<{ id: string }>(
      "SELECT id FROM visitors WHERE workspace_id = $1 AND verified_customer_id = $2",
      [workspaceId, "customer-story2-d"],
    );
    expect(dRow).toBeDefined();
    expect(dRow.id).not.toBe(anonRow.id);
  });
});
