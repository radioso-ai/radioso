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
  const visitorRepository = new VisitorRepository(database.kysely);
  const resolver = new VisitorResolver(visitorRepository);
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
      observed: { country: null, language: null, userAgent: null },
    });
    expect(upgraded.outcome).toBe("upgraded");
    const [afterUpgrade] = await database.query<{ id: string; verified_customer_id: string | null }>(
      "SELECT id, verified_customer_id FROM visitors WHERE id = $1",
      [anonRow.id],
    );
    expect(afterUpgrade.verified_customer_id).toBe("customer-story2-c");

    // FR-007: the freshly created destination row has never seen this browsing session
    // before, so the move carries the triggering turn's own observed facts onto it.
    const moved = await resolver.attachVerifiedIdentity({
      conversationId,
      workspaceId,
      visitorKey,
      verifiedCustomerId: "customer-story2-d",
      observed: { country: "DE", language: "de", userAgent: "TestAgent/1.0" },
    });
    expect(moved.outcome).toBe("moved_new");

    const [stillC] = await database.query<{ verified_customer_id: string | null; conversation_count: number }>(
      "SELECT verified_customer_id, conversation_count FROM visitors WHERE id = $1",
      [anonRow.id],
    );
    expect(stillC.verified_customer_id).toBe("customer-story2-c");
    // Regression: the moved conversation must leave the source row exactly once,
    // not linger from the earlier upgrade-in-place count.
    expect(Number(stillC.conversation_count)).toBe(0);

    const [dRow] = await database.query<{
      id: string;
      conversation_count: number;
      last_country: string | null;
      last_language: string | null;
      last_user_agent: string | null;
    }>(
      "SELECT id, conversation_count, last_country, last_language, last_user_agent FROM visitors WHERE workspace_id = $1 AND verified_customer_id = $2",
      [workspaceId, "customer-story2-d"],
    );
    expect(dRow).toBeDefined();
    expect(dRow.id).not.toBe(anonRow.id);
    // Regression: the fresh insert seeds 0 and moveConversation adds exactly one —
    // a brand-new destination row must end up counting the single moved conversation
    // once, not twice.
    expect(Number(dRow.conversation_count)).toBe(1);
    expect(dRow.last_country).toBe("DE");
    expect(dRow.last_language).toBe("de");
    expect(dRow.last_user_agent).toBe("TestAgent/1.0");
  });

  it("findById scopes a visitor lookup to its own workspace (spec 1277, FR-040/041)", async () => {
    const visitorKey = `find-by-id-${randomUUID()}`;
    const { record } = await visitorRepository.insertOrGet({
      workspaceId,
      visitorKey,
      observed: { country: null, language: null, userAgent: null },
    });

    const found = await visitorRepository.findById(workspaceId, record.id);
    expect(found?.id).toBe(record.id);

    const otherWorkspaceId = randomUUID();
    const notFound = await visitorRepository.findById(otherWorkspaceId, record.id);
    expect(notFound).toBeNull();
  });
});
