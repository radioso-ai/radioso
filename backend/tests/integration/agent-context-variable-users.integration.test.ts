import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("the agents that use a context variable (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const revisions = new AgentRevisionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const variableId = randomUUID();

  const enablement = (agentId: string, enabled = true) => ({
    id: randomUUID(), agentId, variableId, source: "classified", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
    surfacing: "on_reference", enabled, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const snapshot = (enablements: unknown[]) => JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: enablements });

  /** An agent whose draft and published release enable the variable as given; null for no release. */
  const createAgent = async (name: string, uses: { draft: boolean | "disabled"; published: boolean | null }): Promise<string> => {
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, name]);
    const draft = uses.draft === "disabled" ? [enablement(agentId, false)] : uses.draft ? [enablement(agentId)] : [];
    await database.query("INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)", [agentId, workspaceId, snapshot(draft)]);
    if (uses.published !== null) {
      const revisionId = randomUUID();
      await database.query(
        "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version) VALUES ($1, $2, $3, $4::jsonb, 1, now(), 1)",
        [revisionId, agentId, workspaceId, snapshot(uses.published ? [enablement(agentId)] : [])],
      );
      await database.query("UPDATE agents SET published_revision_id = $1 WHERE id = $2", [revisionId, agentId]);
    }
    return agentId;
  };

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [accountId, "Users Co", `users-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [workspaceId, accountId, "Users Workspace", `route-${workspaceId}`]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("lists the agents whose draft or published release enables the variable, each marked by which", async () => {
    const both = await createAgent("A both", { draft: true, published: true });
    const publishedOnly = await createAgent("B published", { draft: false, published: true });
    const draftOnly = await createAgent("C draft", { draft: true, published: false });
    await createAgent("D disabled", { draft: "disabled", published: null });
    await createAgent("E none", { draft: false, published: false });

    await expect(revisions.listContextVariableUsers({ workspaceId, variableId, limit: 25 })).resolves.toEqual({
      users: [
        { agentId: both, agentName: "A both", uses: "both" },
        { agentId: publishedOnly, agentName: "B published", uses: "published" },
        { agentId: draftOnly, agentName: "C draft", uses: "draft" },
      ],
      truncated: false,
    });
    await expect(revisions.listContextVariableUsers({ workspaceId, variableId, limit: 2 })).resolves.toMatchObject({
      users: [{ agentId: both }, { agentId: publishedOnly }],
      truncated: true,
    });
    await expect(revisions.listContextVariableUsers({ workspaceId: randomUUID(), variableId, limit: 25 })).resolves.toEqual({ users: [], truncated: false });
  });
});
