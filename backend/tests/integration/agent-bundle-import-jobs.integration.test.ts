import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentBundleImportCleanupWorker } from "../../src/modules/agentBundle/public.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentBundleImportRepository } from "../../src/db/repositories/agentBundleImportRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const describeIfDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeIfDatabase("agent bundle import jobs (Postgres)", () => {
  let database: Database;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let agents: AgentRepository;
  let imports: AgentBundleImportRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accounts = new AccountRepository(database.kysely);
    workspaces = new WorkspaceRepository(database.kysely);
    agents = new AgentRepository(database.kysely);
    imports = new AgentBundleImportRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => { await database.close(); });

  const seedWorkspace = async () => {
    const account = await accounts.create({ name: "Import jobs", email: `imports-${randomUUID()}@example.com`, passwordHash: "hash" });
    return { account, workspace: await workspaces.create(account.id, "Import jobs workspace") };
  };

  it("uses the active-state unique index to make concurrent keys converge, then permits a failed retry", async () => {
    const { account, workspace } = await seedWorkspace();
    const input = { workspaceId: workspace.id, actorAccountId: account.id, idempotencyKey: `key-${randomUUID()}` };

    const [first, second] = await Promise.all([imports.createOrGet(input), imports.createOrGet(input)]);

    expect([first.status, second.status].sort()).toEqual(["created", "existing"]);
    expect(first.job.id).toBe(second.job.id);
    await imports.markApplying(first.job.id);
    await imports.markFailed(first.job.id, "apply_failed", { terminal: true });

    const retried = await imports.createOrGet(input);
    expect(retried.status).toBe("created");
    expect(retried.job.id).not.toBe(first.job.id);
  });

  it("leases and compensates a stale applying import", async () => {
    const { account, workspace } = await seedWorkspace();
    const orphan = await agents.create(workspace.id, { name: "Orphaned import" });
    const job = await imports.createOrGet({ workspaceId: workspace.id, actorAccountId: account.id, idempotencyKey: null });
    await imports.markApplying(job.job.id);
    await imports.setCreatedAgent(job.job.id, orphan.id);
    await database.query("UPDATE agent_bundle_imports SET updated_at = now() - interval '20 minutes' WHERE id = $1", [job.job.id]);

    const worker = new AgentBundleImportCleanupWorker({
      imports,
      agents: {
        create: async () => ({ agentId: "unused" }),
        delete: async (workspaceId, agentId) => { await agents.deleteByIdAndWorkspaceId(agentId, workspaceId); },
      },
      audit: { record: async () => undefined },
      logger: { info: () => undefined, error: () => undefined },
      orphanAgeMs: 15 * 60 * 1_000,
      cleanupLeaseMs: 60_000,
    });

    await expect(worker.sweep()).resolves.toMatchObject({ compensated: 1, failed: 0 });
    expect(await agents.findByIdAndWorkspaceId(orphan.id, workspace.id)).toBeNull();
    expect(await imports.findById(workspace.id, job.job.id)).toMatchObject({ state: "compensated", agentId: orphan.id });
  });

  it("reclaims stale active jobs without an agent so their idempotency keys do not remain blocked", async () => {
    const { account, workspace } = await seedWorkspace();
    const input = { workspaceId: workspace.id, actorAccountId: account.id, idempotencyKey: `key-${randomUUID()}` };
    const job = await imports.createOrGet(input);
    await imports.markApplying(job.job.id);
    await database.query("UPDATE agent_bundle_imports SET updated_at = now() - interval '20 minutes' WHERE id = $1", [job.job.id]);

    const leaseToken = randomUUID();
    const [claimed] = await imports.claimStaleApplying({ ageSeconds: 15 * 60, leaseSeconds: 60, leaseToken, limit: 1 });

    expect(claimed).toMatchObject({ id: job.job.id, agentId: null });
    await expect(imports.markFailed(claimed!.id, "apply_failed", { terminal: true, leaseToken })).resolves.toBe(true);
    await expect(imports.createOrGet(input)).resolves.toMatchObject({ status: "created" });
  });
});
