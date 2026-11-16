import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import { agentRevisionLockKey } from "../../db/repositories/agentDraftMutation.js";
import { AgentStarterPackApplyRepository } from "../../db/repositories/agentStarterPackApplyRepository.js";
import type { AuthoredDirectiveService } from "../../modules/agents/public.js";
import {
  StarterPackApplyService,
  StarterPackDraftGenerator,
  StarterPackDraftService,
} from "../../modules/agentStarterPack/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { RoutineDefinitionService, RoutineDraftAssistService } from "../../modules/routines/public.js";
import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { ResponseLanguageDetector } from "../../shared/services/responseLanguageDetector.js";
import type { ChatReadiness } from "../../shared/infra/llm/chatReadiness.js";

/**
 * Transaction assembly for applying a starter pack, the same shape as the copilot's atomic
 * routine apply (`copilotRoutineAtomicApply.ts`): one unit of work, the agent's draft lock taken
 * first, and the owning directive and routine services bound to that transaction, so every
 * created item and the idempotency record commit together or not at all.
 *
 * Directive coherence is assessed with the shared directive service, outside the transaction.
 * Inside it, the transaction-bound service only recomputes the coherence context token and
 * saves with the verdict it is given, so no model call happens while the lock is held.
 */
export const buildStarterPackApplyService = (input: {
  db: Db;
  authoredDirectiveService: Pick<AuthoredDirectiveService, "assessCoherence">;
  authoringServicesOn: (db: Db) => {
    authoredDirectiveService: Pick<AuthoredDirectiveService, "list" | "create" | "coherenceContextToken">;
    routineDefinitionService: Pick<RoutineDefinitionService, "findCreateConflict" | "createDraft">;
  };
  routineDefinitionService: Pick<RoutineDefinitionService, "completeExternalDraftMutation">;
  auditService?: Pick<AuditPort, "record">;
  logger?: Pick<AppLogger, "warn">;
}): StarterPackApplyService =>
  new StarterPackApplyService({
    findCompletedApply: (workspaceId, agentId, idempotencyKey) =>
      new AgentStarterPackApplyRepository(input.db).findByKey(workspaceId, agentId, idempotencyKey),
    assessCoherence: (workspaceId, agentId, candidates) =>
      input.authoredDirectiveService.assessCoherence(workspaceId, agentId, candidates),
    unitOfWork: {
      run: (workspaceId, agentId, work) => input.db.transaction().execute(async (trx) => {
        // The lock every directive and routine draft writer for this agent takes. Holding it from
        // the first read means the replay and name checks below cannot be invalidated by another
        // writer before this transaction commits.
        await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
        const { authoredDirectiveService, routineDefinitionService } = input.authoringServicesOn(trx);
        const applies = new AgentStarterPackApplyRepository(trx);
        return work({
          listDirectiveNames: async () =>
            (await authoredDirectiveService.list(workspaceId, agentId)).map((directive) => directive.name),
          routineNameTaken: async (name) =>
            (await routineDefinitionService.findCreateConflict(workspaceId, agentId, name)) !== null,
          coherenceContextToken: (candidates) =>
            authoredDirectiveService.coherenceContextToken(workspaceId, agentId, candidates),
          createDirective: async (directive, assessedCoherence) =>
            (await authoredDirectiveService.create(workspaceId, agentId, directive, { assessedCoherence })).directive,
          createRoutine: async (routine) =>
            (await routineDefinitionService.createDraft(workspaceId, agentId, routine)).routine,
          findApply: (idempotencyKey) => applies.findByKey(workspaceId, agentId, idempotencyKey),
          recordApply: (record) => applies.insert({ ...record, workspaceId, agentId }),
        });
      }),
    },
    afterRoutineCommitted: (workspaceId, agentId, routine) =>
      input.routineDefinitionService.completeExternalDraftMutation(workspaceId, agentId, routine),
    audit: input.auditService,
    logger: input.logger,
  });

/**
 * Assembles the starter pack draft path from existing services. Every port handed to the draft
 * service reads; the services' write methods are deliberately not exposed to it.
 */
export const buildStarterPackDraftService = (input: {
  agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
  authoredDirectiveService: Pick<AuthoredDirectiveService, "list">;
  routineDefinitionService: Pick<RoutineDefinitionService, "list">;
  routineDraftAssistService: Pick<RoutineDraftAssistService, "draft">;
  chatInferencePipeline: Pick<ModelInferencePipeline, "complete">;
  languageDetector: ResponseLanguageDetector;
  chatReadiness: Pick<ChatReadiness, "assertChatConfigured">;
  logger: Pick<AppLogger, "info" | "warn">;
  telemetryService?: Pick<TelemetryService, "emit">;
}): StarterPackDraftService =>
  new StarterPackDraftService({
    agents: input.agentRepository,
    directives: { list: (workspaceId, agentId) => input.authoredDirectiveService.list(workspaceId, agentId) },
    routines: { list: (workspaceId, agentId) => input.routineDefinitionService.list(workspaceId, agentId) },
    routineDrafter: {
      draft: (workspaceId, agentId, request, options) =>
        input.routineDraftAssistService.draft(workspaceId, agentId, request, options),
    },
    chatReadiness: input.chatReadiness,
    generator: new StarterPackDraftGenerator({
      // Unlike the older authoring adapters, this one forwards the abort signal, so a client that
      // disconnects stops the model call.
      textGenerationClient: {
        complete: async (request) => (await input.chatInferencePipeline.complete(request)).text,
      },
      languageDetector: input.languageDetector,
      logger: input.logger,
      telemetryService: input.telemetryService,
    }),
  });
