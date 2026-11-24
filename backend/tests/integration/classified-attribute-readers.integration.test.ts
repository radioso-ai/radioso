import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { ClassifiedContextVariableReads } from "../../src/db/repositories/classifiedContextVariableReads.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import {
  ContextVariableResolverService,
  ConversationValueWriterService,
  contextScopeLadder,
  projectContextForMatching,
  resolveContextForTurn,
  routineContextRenderer,
} from "../../src/modules/context-variables/public.js";
import type { AgentContextVariableEnablement } from "../../src/modules/context-variables/public.js";
import { ConversationClassificationService } from "../../src/modules/contextClassification/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Spec 1884, section 8: the readers slice 1 proves with one test each. A value the AI chose reaches
// a directive condition and a routine step the way the next turn reads it, and stays out of the
// answer prompt under the classified default, "Only rules, routines and skills that name it".
describeIntegration("what reads a value the AI set (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new ContextVariableRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
      accountId, "Readers Co", `readers-${accountId}@example.com`, "hash",
    ]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [
      workspaceId, accountId, "Readers Workspace", `route-${workspaceId}`,
    ]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Readers Agent"]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** A conversation on a release that has the AI set a topic, after the AI chose "billing" for it; then the next turn's context. */
  const nextTurnAfterClassification = async () => {
    const topic = await repository.create({
      workspaceId,
      name: `topic_${randomUUID().replaceAll("-", "_")}`,
      valueType: "enum",
      options: [
        { key: "billing", label: "Rechnungen", description: "Charges, invoices and refunds.", archived: false },
        { key: "shipping", label: "Versand", description: "Delivery and parcels.", archived: false },
      ],
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });
    const now = new Date().toISOString();
    const enablement = {
      id: randomUUID(), agentId, variableId: topic.id, source: "classified", resolverSkillId: null, maxAgeSeconds: null,
      resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
    };
    const revisionId = randomUUID();
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4::jsonb, 1)",
      [revisionId, agentId, workspaceId, JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [enablement] })],
    );
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, agent_revision_id) VALUES ($1, $2, $3, $4)",
      [conversationId, workspaceId, agentId, revisionId],
    );
    const classification = new ConversationClassificationService({
      targets: new ClassifiedContextVariableReads(database.kysely, new AgentRevisionRuntimeRepository(database.kysely)),
      excerpts: { readExcerpt: async () => ({ summary: null, messages: ["Warum wurde mir zweimal abgebucht?"], withheldCount: 0 }) },
      values: new ConversationValueWriterService({ repository }),
      inference: {
        create: async () => ({
          complete: vi.fn(async () => ({
            text: JSON.stringify({ attribute_1: { evidence: "The visitor was charged twice.", option_applies: true, key: "billing" } }),
          })),
        }),
      },
    });
    await expect(classification.classifyNow({ workspaceId, conversationId })).resolves.toMatchObject({ outcome: "written" });

    const resolved = await new ContextVariableResolverService({ repository, resolver: { resolve: vi.fn() } }).resolveForEnablements(
      workspaceId,
      agentId,
      [enablement as unknown as AgentContextVariableEnablement],
      contextScopeLadder({ conversationId, chatSessionId: null, verifiedCustomerId: null, agentId, workspaceId }),
    );
    return { name: topic.name, turn: resolveContextForTurn(null, resolved) };
  };

  it("hands a directive condition the AI's choice as its key and the option's label", async () => {
    const { name, turn } = await nextTurnAfterClassification();

    expect(projectContextForMatching(turn.snapshot).context[name]).toEqual({ key: "billing", label: "Rechnungen" });
    // The classified default keeps it out of the answer prompt.
    expect(turn.renderFragments).toEqual([]);
  });

  it("renders the AI's choice in a routine step's {{context.<name>}} as the option's label", async () => {
    const { name, turn } = await nextTurnAfterClassification();

    expect(routineContextRenderer.render({ name, stagedContext: turn.staged }))
      .toBe(`<context_variable name="${name}">Rechnungen</context_variable>`);
  });
});
