import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { WorkspaceSetupStateRepository } from "../../src/db/repositories/workspaceSetupStateRepository.js";
import { WebhookDestinationRepository } from "../../src/db/repositories/webhookDestinationRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WorkspaceSetupStateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new WorkspaceSetupStateRepository(database.kysely);
  const webhookDestinations = new WebhookDestinationRepository(database.kysely);
  const workspaces = new WorkspaceRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)", [accountId, "Setup Co", `setup-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "Setup Workspace", `setup-${workspaceId}`]);
    await database.query("INSERT INTO workspace_setup_state (workspace_id) VALUES ($1)", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("persists only operator-owned fields without mutating the row on reads", async () => {
    const before = await database.query<{ row_count: string; updated_at: Date }>(
      "SELECT COUNT(*)::text AS row_count, MIN(updated_at) AS updated_at FROM workspace_setup_state WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(await repository.get(workspaceId)).toMatchObject({ workspaceId, purpose: null, dismissedAt: null, skippedSteps: [] });
    expect(await repository.get(workspaceId)).toMatchObject({ workspaceId, purpose: null, dismissedAt: null, skippedSteps: [] });
    const after = await database.query<{ row_count: string; updated_at: Date }>(
      "SELECT COUNT(*)::text AS row_count, MIN(updated_at) AS updated_at FROM workspace_setup_state WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(after).toEqual(before);

    expect(await repository.update(workspaceId, {
      purpose: "Answer support questions",
      dismissed: true,
      skippedSteps: ["credential"],
    })).toMatchObject({ purpose: "Answer support questions", skippedSteps: ["credential"] });
    expect(await repository.get(workspaceId)).toMatchObject({ dismissedAt: expect.any(Date) });
  });

  it("creates an undismissed setup row when a later workspace is created", async () => {
    const created = await workspaces.create(accountId, "Nth Workspace", `nth-${randomUUID()}`);
    await expect(repository.get(created.id)).resolves.toMatchObject({
      workspaceId: created.id,
      dismissedAt: null,
    });
  });

  it("reuses a caller-owned transaction when seeding setup state", async () => {
    const created = await database.kysely.transaction().execute(async (transaction) => {
      return await new WorkspaceRepository(transaction).create(
        accountId,
        "Transactional Workspace",
        `transactional-${randomUUID()}`,
      );
    });

    await expect(repository.get(created.id)).resolves.toMatchObject({
      workspaceId: created.id,
      dismissedAt: null,
    });
  });

  it("rolls back workspace creation when its setup row cannot be seeded", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `reject_setup_${suffix}`;
    const triggerName = `reject_setup_${suffix}`;
    const routeKey = `atomic-${suffix}`;
    await database.execute(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND name = 'Atomic Failure') THEN
          RAISE EXCEPTION 'setup insert rejected for transaction test';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON workspace_setup_state
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    try {
      await expect(workspaces.create(accountId, "Atomic Failure", routeKey)).rejects.toThrow("setup insert rejected");
      await expect(database.query("SELECT 1 FROM workspaces WHERE public_route_key = $1", [routeKey])).resolves.toHaveLength(0);
    } finally {
      await database.execute(`DROP TRIGGER ${triggerName} ON workspace_setup_state; DROP FUNCTION ${functionName}();`);
    }
  });

  it("derives notification confirmation only from a recorded successful delivery", async () => {
    const destination = await webhookDestinations.create({
      workspaceId,
      name: "Setup notifications",
      url: "https://example.com/setup-events",
      secretCiphertext: "ciphertext",
    });

    await expect(repository.getOutcomeFlags(workspaceId)).resolves.toMatchObject({
      hasNotifyDestination: true,
      hasNotifyDeliveryConfirmed: false,
    });

    await webhookDestinations.recordDeliveryOutcome(destination.id, workspaceId, "success");

    await expect(repository.getOutcomeFlags(workspaceId)).resolves.toMatchObject({
      hasNotifyDestination: true,
      hasNotifyDeliveryConfirmed: true,
    });
  });
});
