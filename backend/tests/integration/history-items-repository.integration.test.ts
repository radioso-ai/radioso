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
