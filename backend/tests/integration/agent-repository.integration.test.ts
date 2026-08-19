import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createDefaultAgentSkillSettingsRegistry } from "../../src/app/composition/skillSettingsResolver.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../src/modules/documents/contracts/index.js";
import {
  AgentSurfaceExtensionRegistry,
  defaultAgentEmbedTheme,
  getWebsiteEmbedSurfaceSettings,
  type WebsiteEmbedSurfaceSettings,
} from "../../src/modules/agents/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of AgentRepository. This is the only coverage that
// exercises the actual SQL (now Kysely) end to end: the agent projection (correlated
// source_ids / authored_directives aggregation), the create/update transactions with
// replaceSourceScope, presence-based update (untouched jsonb survives), directive CRUD,
// and the repointRoutineScopeTags shared-transaction path. Behaviour here is the spec the
// Kysely migration must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AgentRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AgentRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  // Two document sources to exercise selected-scope round-trip.
  const sourceA = randomUUID();
  const sourceB = randomUUID();

  const websiteEmbedDefaults = (): WebsiteEmbedSurfaceSettings => ({
    enabled: false,
    token: null,
    allowedOrigins: [],
    launcherLabel: "Chat with us",
    launcherPosition: "bottom-right",
    theme: defaultAgentEmbedTheme(),
    copy: {},
    expertOverrides: {},
  });

  // Seed an agents row directly so the read path parses hand-crafted on-disk JSONB. The
  // shape (output_modes carrying authenticatedChat/anonymousChat/websiteEmbed plus an
  // optional `extensions` map) is the persisted format; behavior_settings / skill_settings
  // / source_scope_mode / source_ids let each case characterise read-path defaulting and
  // parsing that `create()` cannot itself produce.
  const seedAgentRow = async (options: {
    behaviorSettings?: Record<string, unknown>;
    skillSettings?: Record<string, unknown>;
    outputModes?: Record<string, unknown>;
    sourceScopeMode?: "all" | "selected";
    selectedSourceIds?: Array<string | null>;
  } = {}): Promise<string> => {
    const agentId = randomUUID();
    const outputModes = options.outputModes ?? {
      authenticatedChat: { enabled: true },
      anonymousChat: { enabled: false, token: null },
      websiteEmbed: websiteEmbedDefaults(),
    };
    await database.query(
      `INSERT INTO agents (
         id, workspace_id, name, retrieval_enabled, source_scope_mode,
         behavior_settings, greeting_settings, output_modes, skill_settings
       )
       VALUES ($1, $2, $3, true, $4, $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb)`,
      [
        agentId,
        workspaceId,
        "Seeded",
        options.sourceScopeMode ?? "all",
        JSON.stringify(options.behaviorSettings ?? {}),
        JSON.stringify(outputModes),
        JSON.stringify(options.skillSettings ?? {}),
      ],
    );
    // The agent projection rebuilds source_ids from agent_document_sources, so seed those
    // join rows directly (manual-documents sentinel persists as a NULL source_id).
    if (options.sourceScopeMode === "selected") {
      for (const sourceId of options.selectedSourceIds ?? []) {
        await database.query(
          `INSERT INTO agent_document_sources (agent_id, source_id) VALUES ($1, $2)`,
          [agentId, sourceId],
        );
      }
    }
    return agentId;
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Agent Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Agent Workspace", `route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name) VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
      [sourceA, workspaceId, "manual_upload", "Source A", sourceB, "Source B"],
    );
  });

  afterAll(async () => {
    // ON DELETE CASCADE removes the agents/directives/sources created during the test.
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("creates an agent with selected source scope and round-trips the source ids", async () => {
    const agent = await repository.create(workspaceId, {
      name: "Scoped Support",
      customInstruction: "Be concise.",
      sourceScope: {
        mode: "selected",
        sourceIds: [sourceA, sourceB, MANUALLY_ADDED_DOCUMENTS_SOURCE_ID],
      },
    });

    expect(agent.id).toMatch(/[0-9a-f-]{36}/);
    expect(agent.workspaceId).toBe(workspaceId);
    expect(agent.name).toBe("Scoped Support");
    expect(agent.customInstruction).toBe("Be concise.");
    expect(agent.sourceScope.mode).toBe("selected");
    expect(agent.createdAt).toBeInstanceOf(Date);
    expect(agent.updatedAt).toBeInstanceOf(Date);

    // Re-read so source_ids comes from the correlated subquery, not the in-memory shortcut.
    const reread = await repository.findByIdAndWorkspaceId(agent.id, workspaceId);
    expect(reread?.sourceScope.mode).toBe("selected");
    const ids = reread?.sourceScope.mode === "selected" ? reread.sourceScope.sourceIds : [];
    expect(new Set(ids)).toEqual(new Set([sourceA, sourceB, MANUALLY_ADDED_DOCUMENTS_SOURCE_ID]));
  });

  it("creates an all-scope agent with an empty source set", async () => {
    const agent = await repository.create(workspaceId, { name: "All Scope" });
    expect(agent.sourceScope).toEqual({ mode: "all" });

    const reread = await repository.findByIdAndWorkspaceId(agent.id, workspaceId);
    expect(reread?.sourceScope).toEqual({ mode: "all" });
    expect(reread?.authoredDirectives).toEqual([]);
  });

  it("findByIdAndWorkspaceId returns null for a foreign workspace", async () => {
    const agent = await repository.create(workspaceId, { name: "Private" });
    const found = await repository.findByIdAndWorkspaceId(agent.id, randomUUID());
    expect(found).toBeNull();
  });

  it("finds an agent by anonymous chat token and website embed token", async () => {
    const anonymousToken = `anon-${randomUUID()}`;
    const embedToken = `embed-${randomUUID()}`;
    const created = await repository.create(workspaceId, {
      name: "Tokened",
      surfaceSettings: {
        anonymousChat: { enabled: true, token: anonymousToken },
        websiteEmbed: { enabled: true, token: embedToken },
      },
    });

    const byAnon = await repository.findByAnonymousChatToken(anonymousToken);
    expect(byAnon?.id).toBe(created.id);

    const byEmbed = await repository.findByWebsiteEmbedToken(embedToken);
    expect(byEmbed?.id).toBe(created.id);

    expect(await repository.findByAnonymousChatToken("missing")).toBeNull();
  });

  it("setDefault marks an agent as the workspace default and findDefaultByWorkspaceId returns it", async () => {
    const agent = await repository.create(workspaceId, { name: "Default Agent" });
    await repository.setDefault(workspaceId, agent.id);

    const found = await repository.findDefaultByWorkspaceId(workspaceId);
    expect(found?.id).toBe(agent.id);
  });

  it("listByWorkspaceId orders by created_at then id and counts match", async () => {
    const isolatedWorkspace = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [isolatedWorkspace, accountId, "Isolated", `route-${isolatedWorkspace}`],
    );
    const first = await repository.create(isolatedWorkspace, { name: "First" });
    const second = await repository.create(isolatedWorkspace, { name: "Second" });

    const list = await repository.listByWorkspaceId(isolatedWorkspace);
    expect(list.map((agent) => agent.id)).toEqual([first.id, second.id]);

    expect(await repository.countByWorkspaceId(isolatedWorkspace)).toBe(2);
    expect(await repository.countByWorkspaceId(randomUUID())).toBe(0);
  });

  it("update applies presence-based changes and leaves untouched settings intact", async () => {
    const created = await repository.create(workspaceId, {
      name: "Mutable",
      customInstruction: "Original instruction.",
      greetingInstruction: "Original greeting.",
      sourceScope: { mode: "selected", sourceIds: [sourceA] },
    });

    // Update only the name; greeting / customInstruction / source scope must survive.
    const updated = await repository.update(created.id, workspaceId, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.customInstruction).toBe("Original instruction.");
    expect(updated.greetingInstruction).toBe("Original greeting.");
    expect(updated.sourceScope.mode).toBe("selected");
    const updatedIds = updated.sourceScope.mode === "selected" ? updated.sourceScope.sourceIds : [];
    expect(updatedIds).toEqual([sourceA]);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    // Switching the source scope to all clears the join rows.
    const switched = await repository.update(created.id, workspaceId, {
      sourceScope: { mode: "all" },
    });
    expect(switched.sourceScope).toEqual({ mode: "all" });
    const reread = await repository.findByIdAndWorkspaceId(created.id, workspaceId);
    expect(reread?.sourceScope).toEqual({ mode: "all" });
  });

  it("does not rewrite source links when an unrelated patch follows source deletion", async () => {
    const deletedSourceId = randomUUID();
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name) VALUES ($1, $2, $3, $4)`,
      [deletedSourceId, workspaceId, "manual_upload", "Deleted source"],
    );
    const agent = await repository.create(workspaceId, {
      name: "Stale source scope",
      sourceScope: { mode: "selected", sourceIds: [deletedSourceId] },
    });
    await database.query(
      `INSERT INTO agent_skills (
         id, workspace_id, agent_id, skill_name, kind, target_type,
         target_id, config, invocation_mode, enabled
       )
       VALUES ($1, $2, $3, 'answer', 'retrieve', 'source_scope', NULL, $4::jsonb, 'default_answer', true)`,
      [
        randomUUID(),
        workspaceId,
        agent.id,
        JSON.stringify({
          sourceScope: { sourceIds: [deletedSourceId] },
          suggestedQuestionsEnabled: true,
          exposedInputs: { query: true },
        }),
      ],
    );

    // Deleting the source cascades the relational link, while the retrieve-skill JSON
    // remains stale until the operator explicitly edits retrieval scope.
    await database.query(`DELETE FROM document_sources WHERE id = $1`, [deletedSourceId]);

    const updated = await repository.update(agent.id, workspaceId, {
      surfaceSettings: {
        websiteEmbed: {
          allowedOrigins: ["https://new.example.com"],
        },
      },
    });

    expect(updated.surfaceSettings.websiteEmbed.allowedOrigins).toEqual(["https://new.example.com"]);
  });

  it("update rejects a stale optimistic-concurrency token", async () => {
    const created = await repository.create(workspaceId, { name: "Concurrent" });
    await expect(
      repository.update(created.id, workspaceId, { name: "Loser" }, {
        expectedUpdatedAt: new Date(created.updatedAt.getTime() - 60_000),
      }),
    ).rejects.toThrow();
  });

  it("supports the full directive CRUD lifecycle with ordering preserved", async () => {
    const agent = await repository.create(workspaceId, { name: "Directive Host" });

    const first = await repository.createDirective(agent.id, workspaceId, {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
      tags: ["tone"],
      metadata: { source: "test" },
    });
    expect(first.name).toBe("formal-register");
    expect(first.condition).toEqual({ kind: "always" });
    expect(first.routes).toEqual(["retrieval"]);
    expect(first.tags).toEqual(["tone"]);
    expect(first.metadata).toEqual({ source: "test" });
    expect(first.priority).toBeNull();

    const second = await repository.createDirective(agent.id, workspaceId, {
      name: "contextual-help",
      condition: { kind: "contextual", description: "When the user is confused." },
      action: "Offer guidance.",
    });
    expect(second.condition).toEqual({ kind: "contextual", description: "When the user is confused." });

    const listed = await repository.listDirectives(agent.id, workspaceId);
    expect(listed.map((directive) => directive.id)).toEqual([first.id, second.id]);

    // Duplicate name → conflict (409 with the agent-scoped message).
    await expect(
      repository.createDirective(agent.id, workspaceId, {
        name: "formal-register",
        condition: { kind: "always" },
        action: "Dup.",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "formal-register" already exists for this agent.',
    });

    const updated = await repository.updateDirective(agent.id, workspaceId, first.id, {
      action: "Use a very formal register.",
      tags: ["tone", "style"],
    });
    expect(updated.action).toBe("Use a very formal register.");
    expect(updated.tags).toEqual(["tone", "style"]);
    expect(updated.name).toBe("formal-register");

    expect(await repository.deleteDirective(agent.id, workspaceId, second.id)).toBe(true);
    expect(await repository.deleteDirective(agent.id, workspaceId, second.id)).toBe(false);
    expect((await repository.listDirectives(agent.id, workspaceId)).map((d) => d.id)).toEqual([first.id]);
  });

  it("reports duplicate directive renames as conflicts", async () => {
    const agent = await repository.create(workspaceId, { name: "Rename Conflict Host" });
    await repository.createDirective(agent.id, workspaceId, {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    });
    const second = await repository.createDirective(agent.id, workspaceId, {
      name: "handoff-tone",
      condition: { kind: "always" },
      action: "Hand off warmly.",
      routes: ["retrieval"],
    });

    await expect(
      repository.updateDirective(agent.id, workspaceId, second.id, { name: "formal-register" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "formal-register" already exists for this agent.',
    });
  });

  it("deleteByIdAndWorkspaceId reports whether a row was removed", async () => {
    const agent = await repository.create(workspaceId, { name: "Deletable" });
    expect(await repository.deleteByIdAndWorkspaceId(agent.id, workspaceId)).toBe(true);
    expect(await repository.deleteByIdAndWorkspaceId(agent.id, workspaceId)).toBe(false);
  });

  it("repointRoutineScopeTags repoints surviving tags and reports orphans (no transaction)", async () => {
    const agent = await repository.create(workspaceId, { name: "Routine Host" });
    const fromDefinition = randomUUID();
    const toDefinition = randomUUID();
    const survivingStep = "step-keep";
    const orphanStep = "step-gone";

    const directive = await repository.createDirective(agent.id, workspaceId, {
      name: "routine-bound",
      condition: { kind: "always" },
      action: "Follow the routine.",
      tags: [
        `routine:${fromDefinition}`,
        `step:${fromDefinition}:${survivingStep}`,
        `step:${fromDefinition}:${orphanStep}`,
        "unrelated",
      ],
    });

    const result = await repository.repointRoutineScopeTags({
      agentId: agent.id,
      fromDefinitionId: fromDefinition,
      toDefinitionId: toDefinition,
      survivingStepIds: new Set([survivingStep]),
    });

    expect(result.repointed).toBe(2);
    expect(result.orphans).toEqual([
      { directiveId: directive.id, scopeTag: `step:${fromDefinition}:${orphanStep}`, reason: "missing_step" },
    ]);

    const reread = (await repository.listDirectives(agent.id, workspaceId)).find((d) => d.id === directive.id);
    expect(new Set(reread?.tags)).toEqual(
      new Set([
        `routine:${toDefinition}`,
        `step:${toDefinition}:${survivingStep}`,
        `step:${fromDefinition}:${orphanStep}`,
        "unrelated",
      ]),
    );
  });

  it("repointRoutineScopeTags honours a threaded Kysely transaction", async () => {
    const agent = await repository.create(workspaceId, { name: "Routine Tx Host" });
    const fromDefinition = randomUUID();
    const toDefinition = randomUUID();

    const directive = await repository.createDirective(agent.id, workspaceId, {
      name: "routine-tx-bound",
      condition: { kind: "always" },
      action: "Follow the routine.",
      tags: [`routine:${fromDefinition}`],
    });

    const result = await database.kysely.transaction().execute((trx) =>
      repository.repointRoutineScopeTags({
        agentId: agent.id,
        fromDefinitionId: fromDefinition,
        toDefinitionId: toDefinition,
        survivingStepIds: new Set(),
        transaction: trx,
      }),
    );

    expect(result.repointed).toBe(1);
    expect(result.orphans).toEqual([]);

    const reread = (await repository.listDirectives(agent.id, workspaceId)).find((d) => d.id === directive.id);
    expect(reread?.tags).toEqual([`routine:${toDefinition}`]);
  });

  // ---------------------------------------------------------------------------
  // Read-path JSONB parsing/defaulting. These seed an agents row directly with a
  // hand-crafted on-disk shape (often one that predates a setting) and read it back
  // through findByIdAndWorkspaceId — coverage create() cannot produce because create()
  // always writes the current full shape.
  // ---------------------------------------------------------------------------

  it("defaults assistant link UTM attribution on when stored behavior predates the setting", async () => {
    const agentId = await seedAgentRow();
    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);
    expect(agent?.assistantLinkUtmEnabled).toBe(true);
  });

  it("defaults contact request delivery when stored behavior predates the setting", async () => {
    const agentId = await seedAgentRow();
    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);
    expect(agent?.contactRequestDelivery).toEqual({
      recipientEmails: [],
      webhook: null,
    });
  });

  it("parses retrieval-miss handoff behavior from behavior settings", async () => {
    const agentId = await seedAgentRow({ behaviorSettings: { handoffOnRetrievalMiss: true } });
    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);
    expect(agent?.handoffOnRetrievalMiss).toBe(true);
  });

  it("defaults retrieval-miss handoff behavior off when stored behavior predates the setting", async () => {
    const agentId = await seedAgentRow();
    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);
    expect(agent?.handoffOnRetrievalMiss).toBe(false);
  });

  it("parses registered surface extension data on read before mapping website embed settings", async () => {
    const parsedWebsiteEmbed: WebsiteEmbedSurfaceSettings = {
      ...websiteEmbedDefaults(),
      enabled: true,
      token: "extension-token",
      allowedOrigins: ["https://docs.example.com"],
      launcherLabel: "Ask docs",
    };
    const parsed: unknown[] = [];
    const registry = new AgentSurfaceExtensionRegistry();
    registry.register({
      key: "websiteEmbed",
      defaults: websiteEmbedDefaults,
      normalize: (value: unknown) => value,
      serialize: (value: unknown) => value,
      parse: (value: unknown) => {
        parsed.push(value);
        return parsedWebsiteEmbed;
      },
    });
    const scopedRepository = new AgentRepository(database.kysely, registry);

    const agentId = await seedAgentRow({
      outputModes: {
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: {
          ...websiteEmbedDefaults(),
          enabled: true,
          token: `legacy-${randomUUID()}`,
          allowedOrigins: ["https://legacy.example.com"],
          launcherLabel: "Legacy",
        },
        extensions: {
          websiteEmbed: { enabled: true, token: "extension-token" },
        },
      },
    });

    const agent = await scopedRepository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(parsed).toContainEqual({ enabled: true, token: "extension-token" });
    expect(agent).not.toBeNull();
    expect(getWebsiteEmbedSurfaceSettings(agent!)).toEqual(parsedWebsiteEmbed);
  });

  it("falls back to extension defaults when stored extension data is malformed", async () => {
    const registry = new AgentSurfaceExtensionRegistry();
    registry.register({
      key: "websiteEmbed",
      defaults: websiteEmbedDefaults,
      normalize: (value: unknown) => value,
      serialize: (value: unknown) => value,
      parse: () => {
        throw new Error("websiteEmbed extension data is invalid");
      },
    });
    const scopedRepository = new AgentRepository(database.kysely, registry);

    const agentId = await seedAgentRow({
      outputModes: {
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: {
          ...websiteEmbedDefaults(),
          enabled: true,
          token: `legacy-${randomUUID()}`,
          allowedOrigins: ["https://legacy.example.com"],
        },
        extensions: {
          websiteEmbed: "not-a-settings-object",
        },
      },
    });

    const agent = await scopedRepository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(agent).not.toBeNull();
    expect(getWebsiteEmbedSurfaceSettings(agent!)).toEqual(websiteEmbedDefaults());
  });

  it("rehydrates the manual documents sentinel from the stored unassigned source filter", async () => {
    // On disk the manual-documents sentinel is a NULL source_id; sourceA is a real source.
    const agentId = await seedAgentRow({
      sourceScopeMode: "selected",
      selectedSourceIds: [null, sourceA],
    });

    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(agent?.sourceScope.mode).toBe("selected");
    const ids = agent?.sourceScope.mode === "selected" ? agent.sourceScope.sourceIds : [];
    expect(new Set(ids)).toEqual(new Set([MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, sourceA]));
  });

  it("maps skill_settings from storage onto the agent record", async () => {
    const agentId = await seedAgentRow({
      skillSettings: {
        "retrieval.answer": { vectorTopK: 7 },
        "custom.skill": { passthrough: true },
      },
    });

    const agent = await repository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": { vectorTopK: 7 },
      "custom.skill": { passthrough: true },
    });
  });

  it("loads persisted retrieval skill settings with unknown future fields", async () => {
    const scopedRepository = new AgentRepository(
      database.kysely,
      undefined,
      createDefaultAgentSkillSettingsRegistry(),
    );
    const agentId = await seedAgentRow({
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 7,
          futureField: "ignored on read",
        },
      },
    });

    const agent = await scopedRepository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": { vectorTopK: 7 },
    });
  });

  it("loads persisted retrieval skill settings by dropping invalid fields and keeping valid fields", async () => {
    const scopedRepository = new AgentRepository(
      database.kysely,
      undefined,
      createDefaultAgentSkillSettingsRegistry(),
    );
    const agentId = await seedAgentRow({
      skillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: false,
          vectorTopK: 0,
          rerankTopK: 6,
        },
      },
    });

    const agent = await scopedRepository.findByIdAndWorkspaceId(agentId, workspaceId);

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": {
        queryRewriteEnabled: false,
        rerankTopK: 6,
      },
    });
  });
});
