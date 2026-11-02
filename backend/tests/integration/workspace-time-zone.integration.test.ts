import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { WorkspaceTimeZoneSettingsRepository } from "../../src/db/repositories/workspaceTimeZoneSettingsRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("workspace time zone (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const workspaces = new WorkspaceRepository(database.kysely);
  const store = new WorkspaceTimeZoneSettingsRepository(database.kysely);
  const seededAccountIds: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  const seedWorkspace = async () => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Time zone",
      email: `time-zone-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    return workspaces.create(account.id, "Time Zone Workspace");
  };

  it("reads today in UTC for a new workspace, and the workspace record carries the zone a write stores", async () => {
    const workspace = await seedWorkspace();
    expect(workspace.timeZone).toBeNull();
    await expect(store.read(workspace.id)).resolves.toEqual({ accountId: workspace.accountId, settings: { timeZone: null } });

    await expect(store.write({ workspaceId: workspace.id, settings: { timeZone: "America/Los_Angeles" } }))
      .resolves.toEqual({ status: "written", accountId: workspace.accountId, previous: { timeZone: null } });

    expect((await workspaces.findById(workspace.id))?.timeZone).toBe("America/Los_Angeles");
    await expect(store.read(workspace.id)).resolves.toMatchObject({ settings: { timeZone: "America/Los_Angeles" } });
  });

  it("reads the zone a turn resolves today from, null when unset or the workspace is gone", async () => {
    const workspace = await seedWorkspace();
    await expect(store.readWorkspaceTimeZone(workspace.id)).resolves.toBeNull();

    await store.write({ workspaceId: workspace.id, settings: { timeZone: "Asia/Kolkata" } });

    await expect(store.readWorkspaceTimeZone(workspace.id)).resolves.toBe("Asia/Kolkata");
    await expect(store.readWorkspaceTimeZone(randomUUID())).resolves.toBeNull();
  });

  it("writes only while the stored zone still equals the expected one", async () => {
    const workspace = await seedWorkspace();
    await store.write({ workspaceId: workspace.id, settings: { timeZone: "Europe/Rome" } });

    await expect(store.write({ workspaceId: workspace.id, settings: { timeZone: "Asia/Tokyo" }, expected: { timeZone: null } }))
      .resolves.toEqual({ status: "changed" });
    await expect(store.write({ workspaceId: workspace.id, settings: { timeZone: null }, expected: { timeZone: "Europe/Rome" } }))
      .resolves.toEqual({ status: "written", accountId: workspace.accountId, previous: { timeZone: "Europe/Rome" } });
    expect((await workspaces.findById(workspace.id))?.timeZone).toBeNull();
  });

  it("reports a workspace that does not exist", async () => {
    const missing = randomUUID();

    await expect(store.read(missing)).resolves.toBeNull();
    await expect(store.write({ workspaceId: missing, settings: { timeZone: "Europe/Rome" } })).resolves.toEqual({ status: "not_found" });
  });

  it("bounds the stored name's length in the schema itself", async () => {
    const workspace = await seedWorkspace();

    await expect(database.query("UPDATE workspaces SET time_zone = $2 WHERE id = $1", [workspace.id, "x".repeat(65)]))
      .rejects.toThrow(/workspaces_time_zone_check/);
  });
});
