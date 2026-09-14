import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Characterization for ConversationRepository keyset pagination (updated_at, created_at, id)
// — the migrated cursor-tuple comparison.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ConversationRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new ConversationRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const revisionId = randomUUID();
  const revisionTwoId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Conv Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Conv Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [
      agentId,
      workspaceId,
      "Revision test agent",
    ]);
    await database.query(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [
        revisionId,
        agentId,
        workspaceId,
        JSON.stringify({ customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] }),
        1,
      ],
    );
    await database.query(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [
        revisionTwoId,
        agentId,
        workspaceId,
        JSON.stringify({ customInstruction: "second", directives: [], routines: [], contextVariableEnablements: [] }),
        2,
      ],
    );
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM conversations WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const seedOrdered = async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const conv = await repository.create(workspaceId);
      // newest updated_at last; pagination is updated_at DESC.
      await database.query(`UPDATE conversations SET updated_at = $2::timestamptz, created_at = $2::timestamptz WHERE id = $1`, [
        conv.id,
        `2026-06-01T00:00:0${i}.000Z`,
      ]);
      ids.push(conv.id);
    }
    return ids; // index 2 is newest
  };

  it("creates and finds workspace-scoped conversations", async () => {
    const conv = await repository.create(workspaceId);
    expect((await repository.findByIdAndWorkspaceId(conv.id, workspaceId))?.id).toBe(conv.id);
    expect(await repository.findByIdAndWorkspaceId(conv.id, randomUUID())).toBeNull();
  });

  it("defaults conversations to production and preserves the private operator-test purpose", async () => {
    const production = await repository.create(workspaceId);
    const operatorTest = await repository.create(
      workspaceId,
      agentId,
      "authenticated_chat",
      null,
      null,
      null,
      null,
      { purpose: "operator_test" },
    );

    expect(production.purpose).toBe("production");
    expect((await repository.findByIdAndWorkspaceId(operatorTest.id, workspaceId))?.purpose)
      .toBe("operator_test");
  });

  it("never exposes an operator-test conversation through anonymous-session history lookups", async () => {
    const anonymousSessionId = `operator-test-${randomUUID()}`;
    const operatorTest = await repository.create(
      workspaceId,
      agentId,
      "authenticated_chat",
      anonymousSessionId,
      null,
      null,
      null,
      { purpose: "operator_test" },
    );

    expect(await repository.findByIdAndAnonymousSession(
      operatorTest.id,
      workspaceId,
      anonymousSessionId,
      agentId,
    )).toBeNull();
    expect((await repository.listPageByAnonymousSession(workspaceId, anonymousSessionId, { limit: 10 }))
      .conversations).toEqual([]);
  });

  it("persists an immutable agent revision and atomically chooses one concurrent legacy binding", async () => {
    const conversation = await repository.create(workspaceId, agentId);
    const [left, right] = await Promise.all([
      repository.bindAgentRevision({
        conversationId: conversation.id,
        workspaceId,
        agentId,
        agentRevisionId: revisionId,
      }),
      repository.bindAgentRevision({
        conversationId: conversation.id,
        workspaceId,
        agentId,
        agentRevisionId: revisionTwoId,
      }),
    ]);
    const chosen = (await repository.findByIdAndWorkspaceId(conversation.id, workspaceId))?.agentRevisionId;

    expect([revisionId, revisionTwoId]).toContain(chosen);
    expect(left?.agentRevisionId).toBe(chosen);
    expect(right?.agentRevisionId).toBe(chosen);
  });

  it("round-trips typed Slack channel context and defaults to null", async () => {
    const channelContext = {
      provider: "slack" as const,
      team: { id: "T1", name: "Acme" },
      channel: { id: "D1", type: "im" as const },
      user: { id: "U1", displayName: "Dana" },
    };
    const withCtx = await repository.create(workspaceId, null, "slack", null, null, channelContext);
    expect((await repository.findByIdAndWorkspaceId(withCtx.id, workspaceId))?.channelContext).toEqual(channelContext);

    const without = await repository.create(workspaceId);
    expect((await repository.findByIdAndWorkspaceId(without.id, workspaceId))?.channelContext).toBeNull();
  });

  it("binds verified customer ids once without overwriting an existing binding", async () => {
    const createdBound = await repository.create(workspaceId, null, null, null, null, null, "customer-created");
    expect((await repository.findByIdAndWorkspaceId(createdBound.id, workspaceId))?.verifiedCustomerId)
      .toBe("customer-created");

    const conversation = await repository.create(workspaceId);
    await repository.setVerifiedCustomerId(conversation.id, workspaceId, "customer-first");
    await repository.setVerifiedCustomerId(conversation.id, workspaceId, "customer-second");

    expect((await repository.findByIdAndWorkspaceId(conversation.id, workspaceId))?.verifiedCustomerId)
      .toBe("customer-first");
  });

  it("sets a title, is idempotent when unchanged, and never bumps updated_at", async () => {
    const conversation = await repository.create(workspaceId);
    expect((await repository.findByIdAndWorkspaceId(conversation.id, workspaceId))?.title).toBeNull();

    await repository.setTitle(conversation.id, workspaceId, "Refund for order 4821");
    const afterFirstWrite = await repository.findByIdAndWorkspaceId(conversation.id, workspaceId);
    expect(afterFirstWrite?.title).toBe("Refund for order 4821");
    // A title write must never itself reorder the updated-at-sorted inbox list.
    expect(afterFirstWrite?.updatedAt.getTime()).toBe(conversation.updatedAt.getTime());

    // Writing the same title again is a no-op (migration 154's `is distinct
    // from` guard), so a second regeneration with an unchanged topic label
    // never churns the row.
    await repository.setTitle(conversation.id, workspaceId, "Refund for order 4821");
    expect((await repository.findByIdAndWorkspaceId(conversation.id, workspaceId))?.title)
      .toBe("Refund for order 4821");

    // A later regeneration replaces the title outright (never appends).
    await repository.setTitle(conversation.id, workspaceId, "Refund escalated to a human");
    expect((await repository.findByIdAndWorkspaceId(conversation.id, workspaceId))?.title)
      .toBe("Refund escalated to a human");
  });

  it("paginates newest-first with a keyset cursor, total, and hasMore", async () => {
    const ids = await seedOrdered();

    const page1 = await repository.listPageByWorkspaceId(workspaceId, { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.conversations.map((c) => c.id)).toEqual([ids[2], ids[1]]);

    const page2 = await repository.listPageByWorkspaceId(workspaceId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.conversations.map((c) => c.id)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("excludes operator-test conversations by default and returns only them under operator_test scope", async () => {
    // Five conversations: two real, two interactive workbench tests, and one
    // synthetic Ray probe that must stay out of the workbench session list.
    const embed = await repository.create(workspaceId, null, "website_embed");
    const nullSource = await repository.create(workspaceId);
    const testChat = await repository.create(workspaceId, null, "authenticated_chat");
    const replay = await repository.create(workspaceId, null, "workbench_replay");
    const rayProbe = await repository.create(workspaceId, null, "operator_copilot_probe");

    const idsOf = (result: Awaited<ReturnType<typeof repository.listPageByWorkspaceId>>) =>
      new Set(result.conversations.map((c) => c.id));

    // Default (end_user): keep real + NULL, drop operator-test; total reflects the exclusion.
    const defaultPage = await repository.listPageByWorkspaceId(workspaceId, { limit: 50 });
    expect(idsOf(defaultPage)).toEqual(new Set([embed.id, nullSource.id]));
    expect(defaultPage.total).toBe(2);

    // operator_test: only interactive dashboard/workbench sessions, never Ray probes.
    const operatorPage = await repository.listPageByWorkspaceId(workspaceId, {
      limit: 50,
      sourceScope: "operator_test",
    });
    expect(idsOf(operatorPage)).toEqual(new Set([testChat.id, replay.id]));
    expect(operatorPage.total).toBe(2);

    // all: every conversation.
    const allPage = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all" });
    expect(idsOf(allPage)).toEqual(new Set([embed.id, nullSource.id, testChat.id, replay.id, rayProbe.id]));
    expect(allPage.total).toBe(5);
  });

  it("touch bumps updated_at to the front of the page", async () => {
    const ids = await seedOrdered();
    await repository.touch(ids[0], workspaceId); // oldest becomes newest
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 1 });
    expect(page.conversations[0]?.id).toBe(ids[0]);
  });
});
