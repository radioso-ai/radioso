import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migration110 = "110_retrieve_skills_spine.sql";
const migration111 = "111_notify_and_completion_export_skills.sql";
const postgresBooleanInputPattern = "^[[:space:]]*(t(r(u(e)?)?)?|f(a(l(s(e)?)?)?)?|y(e(s)?)?|n(o)?|on|of(f)?|1|0)[[:space:]]*$";
const postgresIntegerInputPattern = "^[[:space:]]*[+-]?[0-9]+[[:space:]]*$";
const postgresIntegerLengthExpression = `length(regexp_replace(
  $1::text,
  '(^[[:space:]]*[+-]?0*)|([[:space:]]*$)',
  '',
  'g'
)) <= 10`;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("retrieve and notify skill bad-data migrations", () => {
  const databaseName = `mig110_111_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, "110_conversation_channel_context.sql");
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  const seedAgent = async (behaviorSettings: Record<string, unknown>): Promise<{
    agentId: string;
    workspaceId: string;
  }> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Account', $2, 'hash')",
      [accountId, `mig110-111-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Workspace', $3)",
      [workspaceId, accountId, `route-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents (id, workspace_id, name, behavior_settings) VALUES ($1, $2, 'Agent', $3::jsonb)",
      [agentId, workspaceId, JSON.stringify(behaviorSettings)],
    );
    return { agentId, workspaceId };
  };

  const seedPublishedCompletionExport = async (agentId: string, workspaceId: string): Promise<void> => {
    const destinationId = randomUUID();
    const definitionId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       ) VALUES ($1, $2, 'Completion export', 'https://example.test/export', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO routine_definition (
         id, agent_id, lineage_id, version, name, status, activation_trigger_description
       ) VALUES ($1, $2, $3, 1, 'Export routine', 'published', 'Export a completion')`,
      [definitionId, agentId, randomUUID()],
    );
    await database.execute(
      `INSERT INTO routine_completion_export (definition_id, enabled, trigger_kinds, destination_ref)
       VALUES ($1, TRUE, ARRAY['complete'], $2)`,
      [definitionId, destinationId],
    );
  };

  it("matches PostgreSQL casts for every accepted legacy form and defaults only values that would raise", async () => {
    const booleanCandidates: Array<[string | null, boolean]> = [
      ["t", true], ["tr", true], ["tru", true], ["TRUE", true], [" yE ", true], ["yes", true], ["on", true], ["1", true], [null, true],
      ["f", false], ["fa", false], ["fal", false], ["fals", false], ["FALSE", false], ["n", false], ["no", false], ["of", false], [" Off ", false], ["0", false],
    ];
    for (const [value, expected] of booleanCandidates) {
      const [result] = await database.query<{
        old_value: boolean;
        new_value: boolean;
        matches_guard: boolean;
      }>(
        `SELECT
           COALESCE(($1::text)::boolean, TRUE) AS old_value,
           COALESCE(
             CASE
               WHEN $1::text IS NULL THEN ($1::text)::boolean
               WHEN $1::text ~* $2 THEN ($1::text)::boolean
             END,
             TRUE
           ) AS new_value,
           $1::text ~* $2 AS matches_guard`,
        [value, postgresBooleanInputPattern],
      );
      expect(result).toEqual({ old_value: expected, new_value: expected, matches_guard: value === null ? null : true });
    }

    for (const value of ["maybe", "o", "truth", "", "{}"] as const) {
      await expect(database.query("SELECT ($1::text)::boolean", [value])).rejects.toThrow();
      const [result] = await database.query<{ new_value: boolean; matches_guard: boolean }>(
        `SELECT
           COALESCE(CASE WHEN $1::text ~* $2 THEN ($1::text)::boolean END, TRUE) AS new_value,
           $1::text ~* $2 AS matches_guard`,
        [value, postgresBooleanInputPattern],
      );
      expect(result).toEqual({ new_value: true, matches_guard: false });
    }

    const integerCandidates: Array<[string | null, number | null]> = [
      ["5", 5], [" 5 ", 5], ["+5", 5], ["-5", -5], ["0005", 5],
      ["+00000000005", 5], ["\t+00005\n", 5], ["2147483647", 2_147_483_647], ["-2147483648", -2_147_483_648], [null, null],
    ];
    for (const [value, expected] of integerCandidates) {
      const [result] = await database.query<{
        old_value: { value: number | null };
        new_value: { value: number | null };
        matches_guard: boolean | null;
      }>(
        `SELECT
           jsonb_build_object('value', ($1::text)::integer) AS old_value,
           CASE
             WHEN $1::text IS NULL THEN jsonb_build_object('value', ($1::text)::integer)
             WHEN $1::text ~ $2 THEN
               CASE
                 WHEN ${postgresIntegerLengthExpression} THEN
                   CASE
                     WHEN ($1::text)::numeric BETWEEN -2147483648 AND 2147483647
                     THEN jsonb_build_object('value', ($1::text)::integer)
                     ELSE '{}'::jsonb
                   END
                 ELSE '{}'::jsonb
               END
             ELSE '{}'::jsonb
           END AS new_value,
           $1::text ~ $2 AS matches_guard`,
        [value, postgresIntegerInputPattern],
      );
      expect(result.old_value).toEqual({ value: expected });
      expect(result.new_value).toEqual(result.old_value);
      expect(result.matches_guard).toBe(value === null ? null : true);
    }

    for (const value of ["5.5", "99999999999", "maybe", "{}", ""] as const) {
      await expect(database.query("SELECT ($1::text)::integer", [value])).rejects.toThrow();
      const [result] = await database.query<{ new_value: Record<string, never>; matches_guard: boolean }>(
        `SELECT
           CASE
             WHEN $1::text ~ $2 THEN
               CASE
                 WHEN ${postgresIntegerLengthExpression} THEN
                   CASE
                     WHEN ($1::text)::numeric BETWEEN -2147483648 AND 2147483647
                     THEN jsonb_build_object('value', ($1::text)::integer)
                     ELSE '{}'::jsonb
                   END
                 ELSE '{}'::jsonb
               END
             ELSE '{}'::jsonb
           END AS new_value,
           $1::text ~ $2 AS matches_guard`,
        [value, postgresIntegerInputPattern],
      );
      expect(result.new_value).toEqual({});
      expect(result.matches_guard).toBe(value === "99999999999");
    }
  });

  it("treats previously failing settings as absent while preserving legacy cast-compatible values", async () => {
    const malformed = await seedAgent({
      suggestedQuestionsEnabled: "maybe",
      suggestedQuestionsCount: "5.5",
      contactRequestsEnabled: "maybe",
      webhookExportsEnabled: "maybe",
    });
    const legacyCompatible = await seedAgent({
      suggestedQuestionsEnabled: "yes",
      suggestedQuestionsCount: " 5 ",
      contactRequestsEnabled: "yes",
      webhookExportsEnabled: "on",
    });
    const wellFormed = await seedAgent({
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 3,
      contactRequestsEnabled: true,
      webhookExportsEnabled: false,
    });
    await seedPublishedCompletionExport(malformed.agentId, malformed.workspaceId);
    await seedPublishedCompletionExport(legacyCompatible.agentId, legacyCompatible.workspaceId);

    await expect(applyTestMigration(database, migration110)).resolves.toBeUndefined();
    await expect(applyTestMigration(database, migration111)).resolves.toBeUndefined();

    const retrieveSkills = await database.query<{
      agent_id: string;
      config: Record<string, unknown>;
    }>(
      `SELECT agent_id, config
       FROM agent_skills
       WHERE agent_id = ANY($1::uuid[]) AND skill_name = 'answer'
       ORDER BY agent_id`,
      [[malformed.agentId, legacyCompatible.agentId, wellFormed.agentId]],
    );
    const retrieveConfigByAgent = new Map(retrieveSkills.map((skill) => [skill.agent_id, skill.config]));

    expect(retrieveConfigByAgent.get(malformed.agentId)).toMatchObject({
      sourceScope: "all",
      suggestedQuestionsEnabled: true,
      exposedInputs: { query: true },
    });
    expect(retrieveConfigByAgent.get(malformed.agentId)).not.toHaveProperty("suggestedQuestionsCount");
    expect(retrieveConfigByAgent.get(legacyCompatible.agentId)).toEqual({
      sourceScope: "all",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 5,
      exposedInputs: { query: true },
    });
    expect(retrieveConfigByAgent.get(wellFormed.agentId)).toEqual({
      sourceScope: "all",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 3,
      exposedInputs: { query: true },
    });

    const contactSkills = await database.query<{ agent_id: string; enabled: boolean }>(
      `SELECT agent_id, enabled
       FROM agent_skills
       WHERE agent_id = ANY($1::uuid[]) AND skill_name = 'contact_human'
       ORDER BY agent_id`,
      [[malformed.agentId, legacyCompatible.agentId, wellFormed.agentId]],
    );
    expect(contactSkills).toHaveLength(2);
    expect(contactSkills).toEqual(expect.arrayContaining([
      { agent_id: legacyCompatible.agentId, enabled: true },
      { agent_id: wellFormed.agentId, enabled: true },
    ]));

    const completionExportSkills = await database.query<{ agent_id: string }>(
      `SELECT agent_id
       FROM agent_skills
       WHERE agent_id = ANY($1::uuid[]) AND skill_name = 'completion_export'`,
      [[malformed.agentId, legacyCompatible.agentId]],
    );
    expect(completionExportSkills).toEqual([{ agent_id: legacyCompatible.agentId }]);
  });

  it("rejects a differently named default-answer skill before it hits the partial unique index", async () => {
    const { agentId, workspaceId } = await seedAgent({});
    await database.execute(
      `INSERT INTO agent_skills (
         id, workspace_id, agent_id, skill_name, kind, target_type, target_id, config, invocation_mode, enabled
       ) VALUES ($1, $2, $3, 'another_answer', 'retrieve', 'source_scope', NULL, '{}'::jsonb, 'default_answer', TRUE)`,
      [randomUUID(), workspaceId, agentId],
    );

    await expect(applyTestMigration(database, migration110)).rejects.toThrow(
      /already have a default-answer skill named other than "answer"/,
    );
  });
});
