import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Covers the raw-SQL source-scope filter in HistoryItemsRepository.listPageByWorkspaceId,
// which backs the Activity items feed (assistantHistoryService.listItems). The NULL-safe
// `end_user` default must keep real conversations (including NULL source_channel) while
// dropping operator-driven test traffic, and both the row set and `total` must agree.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("HistoryItemsRepository source scope (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new HistoryItemsRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  const embedId = randomUUID();
  const nullSourceId = randomUUID();
  const anonymousId = randomUUID();
  const testChatId = randomUUID();
  const replayId = randomUUID();
  const rayProbeId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "History Items Co",
      `hist-items-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "History Items WS",
      `route-${workspaceId}`,
    ]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM conversations WHERE workspace_id = $1`, [workspaceId]);
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel) VALUES
         ($1, $6, 'website_embed'),
         ($2, $6, NULL),
         ($3, $6, 'anonymous'),
         ($4, $6, 'authenticated_chat'),
         ($5, $6, 'workbench_replay'),
         ($7, $6, 'operator_copilot_probe')`,
      [embedId, nullSourceId, anonymousId, testChatId, replayId, workspaceId, rayProbeId],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM conversations WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const chatIds = (result: Awaited<ReturnType<typeof repository.listPageByWorkspaceId>>) =>
    new Set(result.items.flatMap((item) => (item.kind === "chat" ? [item.conversation.id] : [])));

  it("defaults to end_user: keeps real + NULL + anonymous, drops operator-test, total agrees", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50 });
    expect(chatIds(page)).toEqual(new Set([embedId, nullSourceId, anonymousId]));
    expect(chatIds(page)).not.toContain(rayProbeId);
    expect(page.total).toBe(3);
  });

  it("operator_test scope returns only the dashboard test chat + workbench replay", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "operator_test" });
    expect(chatIds(page)).toEqual(new Set([testChatId, replayId]));
    expect(chatIds(page)).not.toContain(rayProbeId);
    expect(page.total).toBe(2);
  });

  it("all scope returns every conversation", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all" });
    expect(chatIds(page)).toEqual(new Set([embedId, nullSourceId, anonymousId, testChatId, replayId, rayProbeId]));
    expect(page.total).toBe(6);
  });
});

// Covers the q/agentId/sourceOrigin/outcome filters (issue #1126) that make the All-lens
// toolbar's search and filters server-side. All four compose with the existing
// pagination/scope filters and stay workspace-scoped.
describeIntegration("HistoryItemsRepository search and filters (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new HistoryItemsRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentAId = randomUUID();
  const agentBId = randomUUID();

  const titleMatchId = randomUUID();
  const firstMessageMatchId = randomUUID();
  const laterMentionOnlyId = randomUUID();
  const wildcardPercentId = randomUUID();
  const wildcardUnderscoreId = randomUUID();
  const agentAConversationId = randomUUID();
  const agentBConversationId = randomUUID();
  const siteAConversationId = randomUUID();
  const siteBConversationId = randomUUID();
  const handedOffId = randomUUID();
  const inProgressId = randomUUID();
  const completedId = randomUUID();
  const searchAuditEventId = randomUUID();

  const insertConversation = async (input: {
    id: string;
    title?: string | null;
    agentId?: string | null;
    sourceOrigin?: string | null;
    updatedAt?: string;
  }) => {
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_origin, title, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))`,
      [input.id, workspaceId, input.agentId ?? null, input.sourceOrigin ?? null, input.title ?? null, input.updatedAt ?? null],
    );
  };

  const insertMessage = async (input: { conversationId: string; role: "user" | "assistant"; content: string; createdAt: string }) => {
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [randomUUID(), input.conversationId, workspaceId, input.role, input.content, input.createdAt],
    );
  };

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "History Search Co",
      `hist-search-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "History Search WS",
      `route-search-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $3, 'Agent A'), ($2, $3, 'Agent B')`, [
      agentAId,
      agentBId,
      workspaceId,
    ]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM conversations WHERE workspace_id = $1`, [workspaceId]);
    await database.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [workspaceId]);

    // Title match: q should find this purely from `title`, regardless of message content.
    // All fixtures below except `inProgressId` use a far-past `updatedAt` so they never
    // fall inside the shared in-progress recency window and leak into the outcome tests.
    const farPast = "2026-01-01T00:00:00Z";

    await insertConversation({ id: titleMatchId, title: "Refund for order 4821", updatedAt: farPast });
    await insertMessage({ conversationId: titleMatchId, role: "user", content: "hey", createdAt: farPast });

    // First-message match: no title, but the first non-blank user message carries the term.
    await insertConversation({ id: firstMessageMatchId, title: null, updatedAt: farPast });
    await insertMessage({ conversationId: firstMessageMatchId, role: "user", content: "I would like a refund please", createdAt: farPast });
    await insertMessage({ conversationId: firstMessageMatchId, role: "assistant", content: "Sure thing", createdAt: "2026-01-01T00:01:00Z" });

    // Later-mention-only: the term appears only in a later assistant reply, never in the
    // first user message or the title — must NOT match "the message the preview shows".
    await insertConversation({ id: laterMentionOnlyId, title: null, updatedAt: farPast });
    await insertMessage({ conversationId: laterMentionOnlyId, role: "user", content: "What are your opening hours", createdAt: farPast });
    await insertMessage({ conversationId: laterMentionOnlyId, role: "assistant", content: "Let me check on the refund for you", createdAt: "2026-01-01T00:01:00Z" });

    // Wildcard escaping: a literal % or _ in the search text must not act as an ILIKE wildcard.
    await insertConversation({ id: wildcardPercentId, title: "50% off deal", updatedAt: farPast });
    await insertConversation({ id: wildcardUnderscoreId, title: "a_b special", updatedAt: farPast });

    // Agent filter.
    await insertConversation({ id: agentAConversationId, agentId: agentAId, updatedAt: farPast });
    await insertConversation({ id: agentBConversationId, agentId: agentBId, updatedAt: farPast });

    // Site (sourceOrigin) filter.
    await insertConversation({ id: siteAConversationId, sourceOrigin: "https://a.example.com", updatedAt: farPast });
    await insertConversation({ id: siteBConversationId, sourceOrigin: "https://b.example.com", updatedAt: farPast });

    // Outcome buckets.
    await insertConversation({ id: handedOffId, updatedAt: farPast });
    await database.query(
      `INSERT INTO conversation_ownership (conversation_id, workspace_id, state) VALUES ($1, $2, 'human_owned')`,
      [handedOffId, workspaceId],
    );
    await insertConversation({ id: inProgressId, updatedAt: new Date().toISOString() });
    await insertConversation({
      id: completedId,
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    // A search-kind row (audit_events), used to prove it disappears once any chat-only
    // filter (q/agentId/sourceOrigin/outcome) is active.
    await database.query(
      `INSERT INTO audit_events (id, event_type, event_status, workspace_id, metadata_json, created_at)
       VALUES ($1, 'document.search', 'success', $2, '{}'::jsonb, now())`,
      [searchAuditEventId, workspaceId],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM conversations WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const chatIds = (result: Awaited<ReturnType<typeof repository.listPageByWorkspaceId>>) =>
    new Set(result.items.flatMap((item) => (item.kind === "chat" ? [item.conversation.id] : [])));
  const kinds = (result: Awaited<ReturnType<typeof repository.listPageByWorkspaceId>>) =>
    new Set(result.items.map((item) => item.kind));

  it("q matches the conversation title", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "refund" });
    expect(chatIds(page)).toEqual(new Set([titleMatchId, firstMessageMatchId]));
  });

  it("q matches the first non-blank user message when there is no title", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "would like a refund" });
    expect(chatIds(page)).toEqual(new Set([firstMessageMatchId]));
  });

  it("q does not match a term that appears only in a later assistant reply", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "refund" });
    expect(chatIds(page)).not.toContain(laterMentionOnlyId);
  });

  it("escapes ILIKE wildcards so a literal % or _ matches only that literal text", async () => {
    const percentPage = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "50%" });
    expect(chatIds(percentPage)).toEqual(new Set([wildcardPercentId]));

    const underscorePage = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "a_b" });
    expect(chatIds(underscorePage)).toEqual(new Set([wildcardUnderscoreId]));
  });

  it("filters by agentId", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", agentId: agentAId });
    expect(chatIds(page)).toEqual(new Set([agentAConversationId]));
  });

  it("filters by sourceOrigin (exact match)", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", sourceOrigin: "https://a.example.com" });
    expect(chatIds(page)).toEqual(new Set([siteAConversationId]));
  });

  it("buckets outcome=handed_off to conversations with a human_owned ownership row", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", outcome: "handed_off" });
    expect(chatIds(page)).toEqual(new Set([handedOffId]));
  });

  it("buckets outcome=in_progress to un-owned conversations updated within the shared window", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", outcome: "in_progress" });
    expect(chatIds(page)).toEqual(new Set([inProgressId]));
  });

  it("buckets outcome=completed to un-owned conversations updated outside the shared window", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", outcome: "completed" });
    expect(chatIds(page)).toContain(completedId);
    expect(chatIds(page)).not.toContain(inProgressId);
    expect(chatIds(page)).not.toContain(handedOffId);
  });

  it("paginates within the filtered set, keeping total/hasMore accurate against the full match count", async () => {
    const page = await repository.listPageByWorkspaceId(workspaceId, {
      limit: 1,
      sourceScope: "all",
      q: "refund",
    });
    // Two conversations match "refund" (title + first-message); a limit of 1 must still
    // report the true total and hasMore across the full filtered set, not just the page.
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("composes multiple filters together (agentId AND sourceOrigin), narrowing to their intersection", async () => {
    // Give the agent-A conversation the same site as siteAConversationId, so filtering by
    // both agentId=agentA and sourceOrigin=site-a should keep only this new conversation,
    // not the pre-existing agent-A-only or site-a-only fixtures.
    const bothId = randomUUID();
    await insertConversation({ id: bothId, agentId: agentAId, sourceOrigin: "https://a.example.com", updatedAt: "2026-01-01T00:00:00Z" });

    const page = await repository.listPageByWorkspaceId(workspaceId, {
      limit: 50,
      sourceScope: "all",
      agentId: agentAId,
      sourceOrigin: "https://a.example.com",
    });
    expect(chatIds(page)).toEqual(new Set([bothId]));
  });

  it("excludes search-kind rows once any chat-only filter is active, but includes them with none", async () => {
    const unfiltered = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all" });
    expect(kinds(unfiltered)).toContain("search");

    const filteredByQ = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", q: "refund" });
    expect(kinds(filteredByQ)).not.toContain("search");

    const filteredByAgent = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", agentId: agentAId });
    expect(kinds(filteredByAgent)).not.toContain("search");

    const filteredByOutcome = await repository.listPageByWorkspaceId(workspaceId, { limit: 50, sourceScope: "all", outcome: "completed" });
    expect(kinds(filteredByOutcome)).not.toContain("search");
  });
});
