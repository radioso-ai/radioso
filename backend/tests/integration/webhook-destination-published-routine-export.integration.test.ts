import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { WebhookDestinationRepository } from "../../src/db/repositories/webhookDestinationRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillTargetUses } from "../../src/modules/agentSkills/public.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { WebhookDestinationService } from "../../src/modules/webhooks/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * A completed routine delivers to the destination its agent's published release froze, so a
 * destination stays in use while that release exports to it, even after the draft pointed the
 * export elsewhere or switched it off. The refusal names the agent and the routine.
 */
describeIntegration("deleting a webhook destination a published routine export uses (Postgres)", () => {
  let database: Database;
  let revisions: AgentRevisionRepository;
  let routines: RoutineDefinitionRepository;
  let service: WebhookDestinationService;
  let accountId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    revisions = new AgentRevisionRepository(database.kysely);
    routines = new RoutineDefinitionRepository(database.kysely);
    service = new WebhookDestinationService({
      repository: new WebhookDestinationRepository(database.kysely),
      auditService: { record: async () => undefined },
      encryption: { key: undefined },
      assertPublicUrl: async () => undefined,
      routineReferences: routines,
      skillTargetUses: new AgentSkillTargetUses(database.kysely),
    });
    accountId = (await new AccountRepository(database.kysely).create({
      name: "Routine export guard IT",
      email: `routine-export-guard-${randomUUID()}@shop.example`,
      passwordHash: "hash",
    })).id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  const createWorkspace = async (): Promise<string> =>
    (await new WorkspaceRepository(database.kysely).create(accountId, `Routine export guard ${randomUUID()}`)).id;

  const createDestination = async (workspaceId: string): Promise<string> => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://hooks.shop.example/orders', 'ciphertext', 'k1')`,
      [id, workspaceId, `Orders ${id}`],
    );
    return id;
  };

  const routineDraft = (destinationRef: string, enabled = true): RoutineDefinitionDraftInput => ({
    name: "Order intake",
    enabled: true,
    activation: { triggerDescription: "Visitor places an order", gateRef: null, priority: 1, reentryMode: "once_per_conversation" },
    slots: [],
    steps: [{ stableStepId: "step_only", kind: "chat", instruction: "Confirm the order", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [
      { fromStep: "step_only", toRef: "term_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    ],
    terminals: [{ stableStepId: "term_complete", kind: "complete", instruction: "Done", ordinal: 0 }],
    completionExport: { enabled, triggerKinds: ["complete"], destinationRef },
  });

  const publish = async (workspaceId: string, agentId: string): Promise<void> => {
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
  };

  const destinationExists = async (id: string): Promise<boolean> =>
    (await database.query(`SELECT 1 FROM workspace_webhook_destinations WHERE id = $1`, [id])).length > 0;

  /** An agent whose published release exports "Order intake" to `destinationId`. */
  const publishedExport = async (workspaceId: string, destinationId: string) => {
    const agent = await new AgentRepository(database.kysely).create(workspaceId, { name: "Shop assistant" });
    const routine = await routines.createDraftWithAgentDraft(workspaceId, agent.id, routineDraft(destinationId));
    await publish(workspaceId, agent.id);
    return { agentId: agent.id, routineId: routine.id };
  };

  it("keeps the destination while the published release exports to it after the draft pointed elsewhere", async () => {
    const workspaceId = await createWorkspace();
    const oldDestination = await createDestination(workspaceId);
    const newDestination = await createDestination(workspaceId);
    const { agentId, routineId } = await publishedExport(workspaceId, oldDestination);

    await routines.updateDraftWithAgentDraft(workspaceId, agentId, routineId, routineDraft(newDestination));

    await expect(service.delete(workspaceId, oldDestination, {})).rejects.toMatchObject({
      statusCode: 409,
      code: "webhook_destination_in_use",
      message: expect.stringContaining(`The published version of agent "Shop assistant" still exports routine "Order intake"`),
    });
    expect(await destinationExists(oldDestination)).toBe(true);

    await publish(workspaceId, agentId);
    await service.delete(workspaceId, oldDestination, {});
    expect(await destinationExists(oldDestination)).toBe(false);
  });

  it("keeps the destination while the published release exports to it after the draft switched the export off", async () => {
    const workspaceId = await createWorkspace();
    const destination = await createDestination(workspaceId);
    const { agentId, routineId } = await publishedExport(workspaceId, destination);

    await routines.updateDraftWithAgentDraft(workspaceId, agentId, routineId, routineDraft(destination, false));

    await expect(service.delete(workspaceId, destination, {})).rejects.toMatchObject({
      statusCode: 409,
      code: "webhook_destination_in_use",
    });

    await publish(workspaceId, agentId);
    await service.delete(workspaceId, destination, {});
    expect(await destinationExists(destination)).toBe(false);
  });

  it("refuses in the database too, for a delete that skips the service", async () => {
    const workspaceId = await createWorkspace();
    const oldDestination = await createDestination(workspaceId);
    const newDestination = await createDestination(workspaceId);
    const { agentId, routineId } = await publishedExport(workspaceId, oldDestination);
    await routines.updateDraftWithAgentDraft(workspaceId, agentId, routineId, routineDraft(newDestination));

    await expect(database.query(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [oldDestination]))
      .rejects.toMatchObject({ constraint: "workspace_webhook_destinations_published_routine_reference" });
  });

  it("names the draft export and leaves out the publish step when no release exports to the destination", async () => {
    const workspaceId = await createWorkspace();
    const destination = await createDestination(workspaceId);
    const agent = await new AgentRepository(database.kysely).create(workspaceId, { name: "Shop assistant" });
    await routines.createDraftWithAgentDraft(workspaceId, agent.id, routineDraft(destination));

    const refusal = await service.delete(workspaceId, destination, {}).catch((error: unknown) => error as Error);
    expect(refusal).toMatchObject({ statusCode: 409, code: "webhook_destination_in_use" });
    expect((refusal as Error).message).toContain(`routine "Order intake" on agent "Shop assistant"`);
    expect((refusal as Error).message).not.toContain("Publish");
  });
});
