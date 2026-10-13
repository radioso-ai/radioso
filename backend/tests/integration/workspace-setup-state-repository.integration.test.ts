import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { WorkspaceSetupStateRepository } from "../../src/db/repositories/workspaceSetupStateRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WorkspaceSetupStateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new WorkspaceSetupStateRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)", [accountId, "Setup Co", `setup-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "Setup Workspace", `setup-${workspaceId}`]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("creates a workspace row lazily and persists only the operator-owned fields", async () => {
    expect(await repository.get(workspaceId)).toMatchObject({ workspaceId, purpose: null, dismissedAt: null, notifyReceiptConfirmedAt: null, skippedSteps: [] });
    expect(await repository.update(workspaceId, {
      purpose: "Answer support questions",
      dismissed: true,
      notifyReceiptConfirmed: true,
      skippedSteps: ["credential"],
    })).toMatchObject({ purpose: "Answer support questions", skippedSteps: ["credential"] });
    expect(await repository.get(workspaceId)).toMatchObject({ dismissedAt: expect.any(Date), notifyReceiptConfirmedAt: expect.any(Date) });
  });
});
