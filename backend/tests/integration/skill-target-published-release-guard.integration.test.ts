import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { ApiConnectionRepository } from "../../src/db/repositories/apiConnectionRepository.js";
import { CustomerEmailConnectionRepository } from "../../src/db/repositories/customerEmailConnectionRepository.js";
import { McpConnectionRepository } from "../../src/db/repositories/mcpConnectionRepository.js";
import { OauthConnectionRepository } from "../../src/db/repositories/oauthConnectionRepository.js";
import { WebhookDestinationRepository } from "../../src/db/repositories/webhookDestinationRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository, AgentSkillTargetUses, type AgentSkillKind } from "../../src/modules/agentSkills/public.js";
import { ApiConnectionService } from "../../src/modules/apiRequestSkills/public.js";
import { CustomerEmailConnectionService, StaticCustomerEmailProviderRegistry } from "../../src/modules/customerEmail/public.js";
import { McpConnectionService } from "../../src/modules/externalSkills/services/mcpConnectionService.js";
import { IntegrationConnectionRepository } from "../../src/modules/integrationConnections/public.js";
import {
  PostgresWorkspaceAccountLookup,
  SlackChannelBindingRepository,
  SlackInstallationRepository,
  SlackInstallationService,
} from "../../src/modules/slack/public.js";
import { WebhookDestinationService } from "../../src/modules/webhooks/public.js";
import type { SkillTargetType } from "../../src/shared/domain/skillTargetUses.js";
import { Database } from "../../src/shared/infra/database.js";
import { pgErrorMeta } from "../../src/shared/infra/kysely/sqlHelpers.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * Conversations run the skills their agent's published release froze, so a connection or
 * destination stays in use while that release runs a skill on it, even after the draft moved
 * the skill. Each target kind refuses its delete then, in its service and in the database.
 */
describeIntegration("deleting a skill target an agent's published release uses (Postgres)", () => {
  let database: Database;
  let skills: AgentSkillRepository;
  let revisions: AgentRevisionRepository;
  let skillTargetUses: AgentSkillTargetUses;
  let accountId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    skills = new AgentSkillRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    skillTargetUses = new AgentSkillTargetUses(database.kysely);
    accountId = (await new AccountRepository(database.kysely).create({
      name: "Skill target guard IT",
      email: `skill-target-guard-${randomUUID()}@shop.example`,
      passwordHash: "hash",
    })).id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  const createWorkspace = async (): Promise<string> =>
    (await new WorkspaceRepository(database.kysely).create(accountId, `Skill target guard ${randomUUID()}`)).id;

  const createAgent = async (workspaceId: string, name: string): Promise<string> =>
    (await new AgentRepository(database.kysely).create(workspaceId, { name })).id;

  const publish = async (workspaceId: string, agentId: string): Promise<string> => {
    const state = await revisions.readState(workspaceId, agentId);
    if (!state) throw new Error("agent has no draft");
    const candidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: state.draft.generation,
    });
    if (candidate === "conflict") throw new Error("candidate conflict");
    const publication = await revisions.publish({
      workspaceId,
      agentId,
      actorAccountId: null,
      revisionId: candidate.id,
      expectedDraftGeneration: state.draft.generation,
      expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
      idempotencyKey: randomUUID(),
    });
    if (typeof publication === "string") throw new Error(`publication ${publication}`);
    return candidate.id;
  };

  const insertOauthConnection = async (workspaceId: string, provider: string): Promise<string> => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, $3, 'OAuth', 'authorized', ARRAY[]::text[])`,
      [id, workspaceId, provider],
    );
    return id;
  };

  interface TargetKind {
    targetType: SkillTargetType;
    skillKind: AgentSkillKind;
    constraint: string;
    skillConfig: Record<string, unknown>;
    create(workspaceId: string): Promise<string>;
    /** Deletes the target the way the operator does, through its owning service. */
    remove(workspaceId: string, targetId: string): Promise<unknown>;
    /** Whether the target row is still there. */
    exists(targetId: string): Promise<boolean>;
    table: string;
  }

  const rowExists = (table: string) => async (targetId: string): Promise<boolean> =>
    (await database.query(`SELECT 1 FROM ${table} WHERE id = $1`, [targetId])).length > 0;

  const kinds: TargetKind[] = [
    {
      targetType: "api_connection",
      skillKind: "api_request",
      constraint: "agent_skills_api_request_target_fk",
      skillConfig: { method: "GET", path: "/orders" },
      table: "api_connections",
      async create(workspaceId) {
        return (await new ApiConnectionRepository(database.kysely).create({
          workspaceId,
          name: `Orders ${randomUUID()}`,
          baseUrl: "https://api.shop.example",
          authScheme: "none",
          authHeaderName: null,
          credentialCiphertext: null,
          defaultHeaders: {},
        })).id;
      },
      remove(workspaceId, targetId) {
        return new ApiConnectionService({
          repository: new ApiConnectionRepository(database.kysely),
          auditService: { record: async () => undefined },
          encryption: { key: undefined },
          assertPublicUrl: async () => undefined,
          send: async () => {
            throw new Error("no request is sent");
          },
          skillTargetUses,
        }).delete(workspaceId, targetId, {});
      },
      exists: rowExists("api_connections"),
    },
    {
      targetType: "mcp_connection",
      skillKind: "external_mcp",
      constraint: "agent_skills_external_mcp_target_fk",
      skillConfig: { toolName: "post_message" },
      table: "mcp_connections",
      async create(workspaceId) {
        const id = randomUUID();
        await database.query(
          `INSERT INTO mcp_connections (id, workspace_id, display_name, server_url, auth_method)
           VALUES ($1, $2, 'Support MCP', 'https://mcp.shop.example', 'access_token')`,
          [id, workspaceId],
        );
        return id;
      },
      remove(workspaceId, targetId) {
        return new McpConnectionService({
          repository: new McpConnectionRepository(database.kysely),
          toolServiceFactory: {
            create: () => {
              throw new Error("no tools are discovered");
            },
          },
          skillTargetUses,
        }).remove(workspaceId, targetId);
      },
      exists: rowExists("mcp_connections"),
    },
    {
      targetType: "webhook_destination",
      skillKind: "webhook",
      constraint: "agent_skills_webhook_target_fk",
      skillConfig: { boundPayload: {}, exposedPayload: {} },
      table: "workspace_webhook_destinations",
      async create(workspaceId) {
        const id = randomUUID();
        await database.query(
          `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
           VALUES ($1, $2, $3, 'https://hooks.shop.example/leads', 'ciphertext', 'k1')`,
          [id, workspaceId, `Leads ${id}`],
        );
        return id;
      },
      remove(workspaceId, targetId) {
        return new WebhookDestinationService({
          repository: new WebhookDestinationRepository(database.kysely),
          auditService: { record: async () => undefined },
          encryption: { key: undefined },
          assertPublicUrl: async () => undefined,
          skillTargetUses,
        }).delete(workspaceId, targetId, {});
      },
      exists: rowExists("workspace_webhook_destinations"),
    },
    {
      targetType: "customer_email_connection",
      skillKind: "customer_email",
      constraint: "agent_skills_customer_email_target_fk",
      skillConfig: { mode: "draft" },
      table: "integration_connections",
      async create(workspaceId) {
        const id = randomUUID();
        await database.query(
          `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, config)
           VALUES ($1, $2, $3, 'customer_email_google', 'Support mailbox', '{"senderEmail":"support@shop.example"}'::jsonb)`,
          [id, workspaceId, await insertOauthConnection(workspaceId, "google_mail")],
        );
        return id;
      },
      remove(workspaceId, targetId) {
        return new CustomerEmailConnectionService({
          repository: new CustomerEmailConnectionRepository(database.kysely),
          oauthConnections: {
            get: async () => {
              throw new Error("no OAuth connection is read");
            },
            list: async () => [],
          },
          providers: new StaticCustomerEmailProviderRegistry([]),
          skillTargetUses,
        }).remove(workspaceId, targetId);
      },
      exists: rowExists("integration_connections"),
    },
    {
      targetType: "slack_installation",
      skillKind: "slack",
      constraint: "agent_skills_slack_target_fk",
      skillConfig: {},
      table: "slack_installations",
      async create(workspaceId) {
        const connectionId = randomUUID();
        await database.query(
          `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, account_id)
           VALUES ($1, $2, $3, 'slack', 'Slack', $4)`,
          [connectionId, workspaceId, await insertOauthConnection(workspaceId, "slack"), accountId],
        );
        const id = randomUUID();
        await database.query(
          `INSERT INTO slack_installations (id, connection_id, workspace_id, account_id, team_id, bot_user_id)
           VALUES ($1, $2, $3, $4, $5, 'U-BOT')`,
          [id, connectionId, workspaceId, accountId, `T-${id}`],
        );
        return id;
      },
      remove(workspaceId) {
        return new SlackInstallationService({
          oauthConnections: new OauthConnectionRepository(database.kysely),
          integrationConnections: new IntegrationConnectionRepository(database.kysely),
          installations: new SlackInstallationRepository(database.kysely),
          bindings: new SlackChannelBindingRepository(database.kysely),
          workspaceAccounts: new PostgresWorkspaceAccountLookup(database.kysely),
          skillTargetUses,
        }).disconnect(workspaceId);
      },
      exists: rowExists("slack_installations"),
    },
  ];

  describe.each(kinds)("$targetType", (kind) => {
    const setUp = async () => {
      const workspaceId = await createWorkspace();
      const agentId = await createAgent(workspaceId, "Support");
      const targetId = await kind.create(workspaceId);
      const skill = await skills.create({
        workspaceId,
        agentId,
        skillName: "reach_target",
        kind: kind.skillKind,
        targetType: kind.targetType,
        targetId,
        config: kind.skillConfig,
        invocationMode: "routine_named",
        enabled: true,
      });
      return { workspaceId, agentId, targetId, skillId: skill.id };
    };

    const directDelete = (targetId: string) =>
      database.query(`DELETE FROM ${kind.table} WHERE id = $1`, [targetId]).catch((error: unknown) => error);

    it("refuses while a draft skill uses it, naming the agent and the skill", async () => {
      const { workspaceId, targetId } = await setUp();

      await expect(kind.remove(workspaceId, targetId)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Used by skill "reach_target" on agent "Support". Delete or retarget that skill first.'),
      });
      expect(pgErrorMeta(await directDelete(targetId))).toMatchObject({ code: "23503", constraint: kind.constraint });
      expect(await kind.exists(targetId)).toBe(true);
    });

    it("refuses while only the published release still uses it, and says to publish first", async () => {
      const { workspaceId, agentId, targetId, skillId } = await setUp();
      await publish(workspaceId, agentId);
      await skills.remove(workspaceId, agentId, skillId);

      await expect(kind.remove(workspaceId, targetId)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          'The published version of agent "Support" still uses skill "reach_target". Publish agent "Support" first.',
        ),
      });
      expect(pgErrorMeta(await directDelete(targetId))).toMatchObject({ code: "23503", constraint: kind.constraint });
      expect(await kind.exists(targetId)).toBe(true);
    });

    it("deletes once the release without the skill is published", async () => {
      const { workspaceId, agentId, targetId, skillId } = await setUp();
      await publish(workspaceId, agentId);
      await skills.remove(workspaceId, agentId, skillId);
      await publish(workspaceId, agentId);

      await kind.remove(workspaceId, targetId);

      expect(await kind.exists(targetId)).toBe(false);
    });

    it("reads the live skills for a release that recorded none", async () => {
      const { workspaceId, agentId, targetId, skillId } = await setUp();
      const releaseId = await publish(workspaceId, agentId);
      await database.query("UPDATE agent_revisions SET snapshot = snapshot - 'agentSkills' WHERE id = $1", [releaseId]);

      await expect(kind.remove(workspaceId, targetId)).rejects.toMatchObject({ statusCode: 409 });

      await skills.remove(workspaceId, agentId, skillId);
      await kind.remove(workspaceId, targetId);

      expect(await kind.exists(targetId)).toBe(false);
    });
  });

  describe("AgentSkillTargetUses", () => {
    it("tells the draft's skills from those only the published release runs, by agent and skill", async () => {
      const workspaceId = await createWorkspace();
      const support = await createAgent(workspaceId, "Support");
      const sales = await createAgent(workspaceId, "Sales");
      const apiConnections = new ApiConnectionRepository(database.kysely);
      const connection = await kinds[0].create(workspaceId);
      const replacement = await kinds[0].create(workspaceId);
      const apiSkill = (agentId: string, skillName: string, targetId: string) => skills.create({
        workspaceId,
        agentId,
        skillName,
        kind: "api_request",
        targetType: "api_connection",
        targetId,
        config: { method: "GET", path: "/orders" },
        invocationMode: "routine_named",
        enabled: true,
      });

      await apiSkill(support, "order_status", connection);
      const moved = await apiSkill(sales, "check_stock", connection);
      await publish(workspaceId, sales);
      await skills.update(workspaceId, sales, moved.id, { targetId: replacement });

      expect(await skillTargetUses.listSkillTargetUses({ workspaceId, targetType: "api_connection", targetId: connection })).toEqual([
        { agentId: sales, agentName: "Sales", skillName: "check_stock", inDraft: false, inPublishedRelease: true },
        { agentId: support, agentName: "Support", skillName: "order_status", inDraft: true, inPublishedRelease: false },
      ]);
      expect(await skillTargetUses.listSkillTargetUses({ workspaceId, targetType: "api_connection", targetId: replacement })).toEqual([
        { agentId: sales, agentName: "Sales", skillName: "check_stock", inDraft: true, inPublishedRelease: false },
      ]);
      expect(await skillTargetUses.listSkillTargetUses({ workspaceId: await createWorkspace(), targetType: "api_connection", targetId: connection })).toEqual([]);
      expect(await apiConnections.findByIdAndWorkspace(connection, workspaceId)).not.toBeNull();
    });
  });

  it("lets a workspace go with the skills and targets its agents' releases use", async () => {
    const workspaceId = await createWorkspace();
    const agentId = await createAgent(workspaceId, "Support");
    const installation = await kinds[4].create(workspaceId);
    await skills.create({
      workspaceId,
      agentId,
      skillName: "post_to_slack",
      kind: "slack",
      targetType: "slack_installation",
      targetId: installation,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });
    await publish(workspaceId, agentId);

    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);

    expect(await kinds[4].exists(installation)).toBe(false);
  });
});
