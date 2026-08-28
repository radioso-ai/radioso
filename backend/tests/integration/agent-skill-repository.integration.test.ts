import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReachIntegrationDatabase(integrationDatabaseUrl)) ? describe : describe.skip;

// Verifies the concrete Kysely-backed AgentSkillRepository against Postgres — the
// in-memory facade test cannot exercise the jsonb shallow-merge on update, the
// explicit-null vs absent target_id semantics, or DELETE row counting.
describeIfDatabase("AgentSkillRepository (Kysely) against Postgres", () => {
  let database: Database;
  let repository: AgentSkillRepository;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    repository = new AgentSkillRepository(database.kysely);

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const agentRepository = new AgentRepository(database.kysely);
    const account = await accountRepository.create({
      name: "Skill Repo IT",
      email: `agent-skill-repo-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Skill Repo IT");
    workspaceId = workspace.id;
    const agent = await agentRepository.create(workspace.id, { name: "Skill Repo Agent" });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  it("creates, reads by id/name, and lists by agent in name order", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "alpha",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    expect(created).toMatchObject({
      skillName: "alpha",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      invocationMode: "routine_named",
      enabled: true,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
    });

    await repository.create({
      workspaceId,
      agentId,
      skillName: "beta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: false,
    });

    expect(await repository.findById(workspaceId, agentId, created.id)).toMatchObject({ skillName: "alpha" });
    expect(await repository.findByName(workspaceId, agentId, "beta")).toMatchObject({ enabled: false });
    expect((await repository.listByAgent(workspaceId, agentId)).map((s) => s.skillName)).toEqual(["alpha", "beta"]);
    // Cross-workspace / cross-agent isolation.
    expect(await repository.findByName(randomUUID(), agentId, "alpha")).toBeNull();
    expect(await repository.findById(workspaceId, randomUUID(), created.id)).toBeNull();
  });

  it("deep-merges config and honors explicit-null vs absent target_id on update", async () => {
    // `retrieve`/`source_scope` targets are not UUID-validated by the target-reference
    // trigger, so an arbitrary text target_id keeps this a pure repository-mechanics test.
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "gamma",
      kind: "retrieve",
      targetType: "source_scope",
      targetId: "scope-1",
      config: { boundPayload: { a: 1 }, exposedPayload: { x: true } },
      invocationMode: "routine_named",
      enabled: true,
    });

    // Partial config update: only boundPayload provided → exposedPayload survives the merge.
    const merged = await repository.update(workspaceId, agentId, created.id, {
      config: { boundPayload: { a: 2, b: 3 } },
    });
    expect(merged?.config).toEqual({ boundPayload: { a: 2, b: 3 }, exposedPayload: { x: true } });
    // target_id untouched when the key is absent.
    expect(merged?.targetId).toBe("scope-1");

    // enabled:false must persist (not be treated as "leave unchanged").
    const disabled = await repository.update(workspaceId, agentId, created.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);

    // Explicit null target_id clears it.
    const cleared = await repository.update(workspaceId, agentId, created.id, { targetId: null });
    expect(cleared?.targetId).toBeNull();

    // Update against a foreign agent is a no-op (returns null).
    expect(await repository.update(workspaceId, randomUUID(), created.id, { enabled: true })).toBeNull();
  });

  it("preserves a stored notify webhook URL when a PATCH supplies only the recipient list", async () => {
    // The defect this guards: notifyDeliverySchema's `.default(null)` on `webhook` means a
    // shallow top-level `config` merge that replaces the whole `delivery` object silently resets
    // a webhook URL the caller never touched.
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "notify-webhook-survives",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {
        delivery: {
          recipientEmails: ["ops@example.com"],
          webhook: { url: "https://hooks.example.com/abc" },
        },
        exposedInputs: { message: true },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    const updated = await repository.update(workspaceId, agentId, created.id, {
      config: { delivery: { recipientEmails: ["ops2@example.com"] } },
    });

    expect(updated?.config).toEqual({
      delivery: {
        recipientEmails: ["ops2@example.com"],
        webhook: { url: "https://hooks.example.com/abc" },
      },
      exposedInputs: { message: true },
    });
  });

  it("serializes two concurrent partial-config PATCHes to sibling nested keys instead of losing one", async () => {
    // Two concurrent PATCHes each touch a different nested key under the same top-level
    // `delivery` object and never see each other's payload. Without a real lock around the
    // read-modify-write, whichever write commits last would read a stale base and clobber the
    // other's change. The repository's `FOR UPDATE` read inside one transaction must serialize
    // these instead, so both edits land.
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "notify-concurrent-patch",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {
        delivery: {
          recipientEmails: ["ops@example.com"],
          webhook: { url: "https://hooks.example.com/original" },
        },
        exposedInputs: { message: true },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    await Promise.all([
      repository.update(workspaceId, agentId, created.id, {
        config: { delivery: { recipientEmails: ["ops2@example.com"] } },
      }),
      repository.update(workspaceId, agentId, created.id, {
        config: { delivery: { webhook: { url: "https://hooks.example.com/updated" } } },
      }),
    ]);

    const final = await repository.findById(workspaceId, agentId, created.id);
    expect(final?.config).toEqual({
      delivery: {
        recipientEmails: ["ops2@example.com"],
        webhook: { url: "https://hooks.example.com/updated" },
      },
      exposedInputs: { message: true },
    });
  });

  it("refuses an update whose expectedUpdatedAt no longer matches, and leaves the row unchanged", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "epsilon",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    const draftedAt = created.updatedAt;

    // A concurrent edit lands after the caller read draftedAt but before it calls update.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = await repository.update(workspaceId, agentId, created.id, { enabled: false });
    expect(edited?.updatedAt.getTime()).toBeGreaterThan(draftedAt.getTime());

    // The version check lives in the UPDATE's own WHERE predicate: a stale expectedUpdatedAt
    // must be a no-op (null), not a partial or unconditional write.
    const stale = await repository.update(
      workspaceId,
      agentId,
      created.id,
      { config: { delivery: { recipientEmails: ["hijacked@example.com"], webhook: null } }, expectedUpdatedAt: draftedAt },
    );
    expect(stale).toBeNull();
    expect((await repository.findById(workspaceId, agentId, created.id))?.config).not.toMatchObject({
      delivery: { recipientEmails: ["hijacked@example.com"] },
    });

    // A fresh expectedUpdatedAt (matching the edit) succeeds.
    const fresh = (await repository.findById(workspaceId, agentId, created.id))!;
    const applied = await repository.update(workspaceId, agentId, created.id, {
      enabled: true,
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect(applied?.enabled).toBe(true);
  });

  it("removes only the matching row and reports whether a row was deleted", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "delta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(await repository.remove(workspaceId, randomUUID(), created.id)).toBe(false);
    expect(await repository.findById(workspaceId, agentId, created.id)).not.toBeNull();
    expect(await repository.remove(workspaceId, agentId, created.id)).toBe(true);
    expect(await repository.findById(workspaceId, agentId, created.id)).toBeNull();
  });

  it("reports the freshest skill write, isolated per agent, and null when an agent has no skills", async () => {
    const agentRepository = new AgentRepository(database.kysely);
    const otherAgent = await agentRepository.create(workspaceId, { name: "Skill Repo Freshness Agent" });
    expect(await repository.latestUpdatedAt(workspaceId, otherAgent.id)).toBeNull();

    const created = await repository.create({
      workspaceId,
      agentId: otherAgent.id,
      skillName: "epsilon",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });
    // The watermark is touched via clock_timestamp() in a statement separate from the row's own
    // now()-stamped updated_at, so it trails it by a hair rather than matching to the millisecond
    // - "at least as fresh as", not "identical to", is the real invariant.
    expect((await repository.latestUpdatedAt(workspaceId, otherAgent.id))?.getTime())
      .toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const updated = await repository.update(workspaceId, otherAgent.id, created.id, { enabled: false });
    const latest = await repository.latestUpdatedAt(workspaceId, otherAgent.id);
    expect(latest!.getTime()).toBeGreaterThanOrEqual(updated!.updatedAt.getTime());
    expect(latest!.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    // Isolated per agent: a sibling agent's skill write never moves this agent's watermark.
    expect(await repository.latestUpdatedAt(workspaceId, randomUUID())).toBeNull();
  });

  it("advances the freshness watermark on delete, even past the deleted skill's own timestamp and down to zero surviving skills", async () => {
    // The defect this guards: latestUpdatedAt used to be MAX(updated_at) over surviving
    // agent_skills rows, so deleting the *freshest* skill made it fall back to an older
    // survivor's timestamp - or to null once no skill remained - even though a real change (the
    // delete) had just happened. Copilot replay evidence captured before that delete would still
    // read as fresh, describing an agent configuration that no longer exists.
    const agentRepository = new AgentRepository(database.kysely);
    const deletionAgent = await agentRepository.create(workspaceId, { name: "Skill Repo Deletion Agent" });

    const older = await repository.create({
      workspaceId,
      agentId: deletionAgent.id,
      skillName: "zeta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await repository.create({
      workspaceId,
      agentId: deletionAgent.id,
      skillName: "eta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });
    // Same clock_timestamp()-vs-now() trailing gap as above: "at least as fresh as", not exact.
    expect((await repository.latestUpdatedAt(workspaceId, deletionAgent.id))?.getTime())
      .toBeGreaterThanOrEqual(newer.updatedAt.getTime());

    // Delete the freshest skill: a surviving-rows MAX would fall back to `older`'s timestamp,
    // moving the watermark backwards relative to what it reported a moment ago.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await repository.remove(workspaceId, deletionAgent.id, newer.id)).toBe(true);
    const afterDeletingNewer = await repository.latestUpdatedAt(workspaceId, deletionAgent.id);
    expect(afterDeletingNewer).not.toBeNull();
    expect(afterDeletingNewer!.getTime()).toBeGreaterThan(newer.updatedAt.getTime());

    // Delete the agent's last remaining skill: must not fall back to null. The agent still had a
    // skill at the moment a case might have captured it, and that skill is now gone.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await repository.remove(workspaceId, deletionAgent.id, older.id)).toBe(true);
    const afterDeletingLast = await repository.latestUpdatedAt(workspaceId, deletionAgent.id);
    expect(afterDeletingLast).not.toBeNull();
    expect(afterDeletingLast!.getTime()).toBeGreaterThan(afterDeletingNewer!.getTime());
  });

  it("still reports a write made through a different repository sharing the agent_skills table", async () => {
    // webhook, customer_email, external_mcp, and slack skills are written through their own
    // dedicated repositories (webhookSkillDefinitionRepository and friends) that share this table
    // but do not know about this class's watermark. latestUpdatedAt must not regress to reporting
    // only writes this class made itself - it has to keep noticing theirs too, via the surviving
    // row's own updated_at, alongside the watermark that covers this class's deletes.
    const agentRepository = new AgentRepository(database.kysely);
    const externalWriterAgent = await agentRepository.create(workspaceId, { name: "Skill Repo External Writer Agent" });
    expect(await repository.latestUpdatedAt(workspaceId, externalWriterAgent.id)).toBeNull();

    // `retrieve`/`source_scope` targets are not UUID-validated by the target-reference trigger
    // (see the "deep-merges config" test above), which keeps this insert a pure simulation of an
    // external writer rather than a real webhook-skill setup.
    const inserted = await database.kysely
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        agent_id: externalWriterAgent.id,
        skill_name: "theta",
        kind: "retrieve",
        target_type: "source_scope",
        target_id: "scope-1",
        invocation_mode: "routine_named",
        enabled: true,
      })
      .returning("updated_at")
      .executeTakeFirstOrThrow();

    const latest = await repository.latestUpdatedAt(workspaceId, externalWriterAgent.id);
    expect(latest).not.toBeNull();
    expect(latest!.getTime()).toBe(new Date(inserted.updated_at).getTime());
  });
});
