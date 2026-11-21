import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { ApiConnectionRepository } from "../../src/db/repositories/apiConnectionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { pgErrorMeta } from "../../src/shared/infra/kysely/sqlHelpers.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ApiConnectionRepository and the api_request skill target (Postgres)", () => {
  let database: Database;
  let repository: ApiConnectionRepository;
  let skills: AgentSkillRepository;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    await runAllTestMigrations(database);
    repository = new ApiConnectionRepository(database.kysely);
    skills = new AgentSkillRepository(database.kysely);
    const account = await new AccountRepository(database.kysely).create({
      name: "API Connection IT",
      email: `api-connection-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspaces = new WorkspaceRepository(database.kysely);
    workspaceId = (await workspaces.create(account.id, "API Connection IT")).id;
    otherWorkspaceId = (await workspaces.create(account.id, "API Connection IT other")).id;
    agentId = (await new AgentRepository(database.kysely).create(workspaceId, { name: "API Agent" })).id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  const write = (name: string) => ({
    name,
    baseUrl: "https://api.example.com/v1",
    authScheme: "bearer" as const,
    authHeaderName: null,
    credentialCiphertext: "enc",
    defaultHeaders: { "X-Api-Version": "2024-01" },
  });

  it("creates, finds workspace-scoped, lists by name, updates and deletes", async () => {
    const created = await repository.create({ ...write("Orders API"), workspaceId });
    expect(created).toMatchObject({ workspaceId, name: "Orders API", authScheme: "bearer", defaultHeaders: { "X-Api-Version": "2024-01" } });
    expect((await repository.findByIdAndWorkspace(created.id, workspaceId))?.id).toBe(created.id);
    expect(await repository.findByIdAndWorkspace(created.id, otherWorkspaceId)).toBeNull();
    expect(await repository.findByIdAndWorkspace("not-a-uuid", workspaceId)).toBeNull();

    await repository.create({ ...write("accounts API"), workspaceId });
    const names = (await repository.listByWorkspace(workspaceId)).map((connection) => connection.name);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));

    const updated = await repository.update(created.id, workspaceId, {
      ...write("Orders API v2"),
      authScheme: "none",
      credentialCiphertext: null,
      defaultHeaders: {},
    });
    expect(updated).toMatchObject({ name: "Orders API v2", authScheme: "none", credentialCiphertext: null, defaultHeaders: {} });

    expect(await repository.delete(created.id, workspaceId)).toBe(true);
    expect(await repository.delete(created.id, workspaceId)).toBe(false);
  });

  it("keeps one name per workspace, case-insensitively", async () => {
    await repository.create({ ...write("Billing"), workspaceId });
    await expect(repository.create({ ...write("billing"), workspaceId })).rejects.toMatchObject({ code: "23505" });
    await expect(repository.create({ ...write("billing"), workspaceId: otherWorkspaceId })).resolves.toMatchObject({ name: "billing" });
  });

  it("refuses an auth scheme without its credential or header name, and a public http base URL", async () => {
    await expect(repository.create({ ...write("No credential"), workspaceId, credentialCiphertext: null })).rejects.toMatchObject({ code: "23514" });
    await expect(repository.create({ ...write("No header"), workspaceId, authScheme: "header" })).rejects.toMatchObject({ code: "23514" });
    await expect(repository.create({ ...write("Plain http"), workspaceId, baseUrl: "http://api.example.com" })).rejects.toMatchObject({ code: "23514" });
  });

  it("lets an api_request skill target only an API connection in its own workspace, and blocks deleting one in use", async () => {
    const connection = await repository.create({ ...write("Tickets API"), workspaceId });
    const foreign = await repository.create({ ...write("Tickets API"), workspaceId: otherWorkspaceId });
    const createSkill = (name: string, targetType: string, targetId: string) => skills.create({
      workspaceId,
      agentId,
      skillName: name,
      kind: "api_request",
      targetType,
      targetId,
      config: { method: "GET", path: "/tickets" },
      invocationMode: "routine_named",
      enabled: true,
    });

    const wrongType = await createSkill("wrong_type", "webhook_destination", connection.id).catch((error: unknown) => error);
    expect(pgErrorMeta(wrongType)).toMatchObject({ code: "23503", constraint: "agent_skills_api_request_target_fk" });
    const crossWorkspace = await createSkill("cross_workspace", "api_connection", foreign.id).catch((error: unknown) => error);
    expect(pgErrorMeta(crossWorkspace)).toMatchObject({ code: "23503", constraint: "agent_skills_api_request_target_fk" });

    await createSkill("ticket_status", "api_connection", connection.id);
    expect(await repository.listSkillNamesReferencingConnection(workspaceId, connection.id)).toEqual(["ticket_status"]);

    const blocked = await repository.delete(connection.id, workspaceId).catch((error: unknown) => error);
    expect(pgErrorMeta(blocked)).toMatchObject({ code: "23503", constraint: "agent_skills_api_request_target_fk" });
    expect(await repository.findByIdAndWorkspace(connection.id, workspaceId)).not.toBeNull();
  });
});
