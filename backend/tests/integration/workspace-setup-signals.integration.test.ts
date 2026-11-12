import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WorkspaceSetupStateRepository } from "../../src/db/repositories/workspaceSetupStateRepository.js";
import { WorkspaceSummaryService } from "../../src/modules/workspace/services/workspaceSummaryService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("workspace setup signals (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const service = new WorkspaceSummaryService(
    new DocumentRepository(database.kysely),
    new ConversationRepository(database.kysely),
    new WorkspaceSetupStateRepository(database.kysely),
  );
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  const insertWorkspace = async (id: string) => {
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)", [id, accountId, `Signals ${id}`, `signals-${id}`]);
    await database.query("INSERT INTO workspace_setup_state (workspace_id) VALUES ($1)", [id]);
  };
  const insertDocument = (workspace: string, status: string) => database.query(
    "INSERT INTO documents (id, title, source_content, markdown_content, status, workspace_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [randomUUID(), "Doc", "body", "body", status, workspace],
  );

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)", [accountId, "Signals Co", `signals-${accountId}@example.com`, "hash"]);
    await insertWorkspace(workspaceId);
    await insertWorkspace(otherWorkspaceId);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reports nothing for a workspace nothing has happened in", async () => {
    expect(await service.getSetupSignals(workspaceId)).toMatchObject({ hasReadyDocuments: false, hasCompletedChat: false, setup: { shouldShowFirstRun: true } });
  });

  it("does not count a document that is not ready", async () => {
    await insertDocument(workspaceId, "processing");
    await insertDocument(workspaceId, "failed");
    expect((await service.getSetupSignals(workspaceId)).hasReadyDocuments).toBe(false);
  });

  it("agrees with the summary once a document is ready and a conversation exists, and reads only its own workspace", async () => {
    await insertDocument(otherWorkspaceId, "ready");
    expect((await service.getSetupSignals(workspaceId)).hasReadyDocuments).toBe(false);

    await insertDocument(workspaceId, "ready");
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)", [randomUUID(), workspaceId]);

    const signals = await service.getSetupSignals(workspaceId);
    const summary = await service.getSummary(workspaceId);
    expect(signals).toEqual({ hasReadyDocuments: true, hasCompletedChat: true, setup: summary.setup });
    expect(signals.setup.shouldShowFirstRun).toBe(false);
  });
});
