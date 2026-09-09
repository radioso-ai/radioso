import {
  ChatGatewayLlmJudge,
  EvalCaseService,
  EvalMessageCaseRepository,
  EvalMessageCaseService,
  EvalRepository,
  EvalRunService,
  EvalSnapshotService,
  EvalSuiteService,
  RetrievalPipelineEvalRunner,
} from "../../../modules/eval/composition.js";
import { RevisionEvalRunRepository } from "../../../db/repositories/revisionEvalRunRepository.js";
import { ContextVariableRepository } from "../../../db/repositories/contextVariableRepository.js";
import { RevisionEvalRunService } from "../../../modules/eval/services/revisionEvalRun.js";
import { createLiveAgentConfigReader } from "../../composition/liveAgentConfigReader.js";
import { TtlRetentionWorker } from "../../../shared/domain/ttlRetentionWorker.js";
import {
  CustomerReplyDeliveryDispatcher,
} from "../../../modules/customerReplyDelivery/public.js";
import { OperatorReplyService } from "../../../modules/handoff/public.js";
import {
  PostgresSlackConversationLinkLookup,
  SlackCustomerReplyDeliverer,
  SlackWebApiClient,
} from "../../../modules/slack/public.js";
import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { RoutineStateRepository } from "../../../db/repositories/routineStateRepository.js";
import { ConversationSummaryRepository } from "../../../db/repositories/conversationSummaryRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { PublicConversationEventBus } from "../../../modules/chat/composition.js";
import { buildInfrastructure, buildRepositories } from "./infra.js";
import type { buildChatServices } from "./chat.js";
import type { buildRetrievalServices } from "./documentsRetrieval.js";
import type { buildIntegrationServices } from "./integrations.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

export const buildEvalServices = (input: {
  chat: Pick<ReturnType<typeof buildChatServices>, "answerPresentation" | "chatGateway" | "workbenchReplayRunner">;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  integrations: Pick<ReturnType<typeof buildIntegrationServices>, "externalSkillDefinitionRepository" | "mcpConnectionRepository" | "slackInstallationService">;
  logger: AppLogger;
  publicConversationEventBus: PublicConversationEventBus;
  repositories: ReturnType<typeof buildRepositories>;
  retrieval: Pick<ReturnType<typeof buildRetrievalServices>, "retrievalPipeline">;
  llmCapabilityResolver: ConstructorParameters<typeof RetrievalPipelineEvalRunner>[2];
  retrievalDefaultsProvider: ConstructorParameters<typeof RetrievalPipelineEvalRunner>[3];
  skillSettingsResolver: NonNullable<ConstructorParameters<typeof RetrievalPipelineEvalRunner>[5]>;
  workspaceInvalidationPublisher: WorkspaceInvalidationPublisher;
  revisionEvalRunRetentionDays: number;
}) => {
  const evalRepository = new EvalRepository(input.infrastructure.database.kysely);
  const evalSnapshotService = new EvalSnapshotService(
    input.repositories.conversationRepository,
    input.repositories.messageRepository,
    input.repositories.agentRepository,
    input.retrievalDefaultsProvider,
    input.skillSettingsResolver,
    evalRepository,
    {
      connections: input.integrations.mcpConnectionRepository,
      skillDefinitions: input.integrations.externalSkillDefinitionRepository,
    },
    new RoutineStateRepository(input.infrastructure.database.kysely),
    new ConversationSummaryRepository(input.infrastructure.database.kysely),
  );
  const evalCaseService = new EvalCaseService(evalRepository);
  const evalMessageCaseRepository = new EvalMessageCaseRepository(input.infrastructure.database.kysely);
  const evalMessageCaseService = new EvalMessageCaseService(
    evalMessageCaseRepository,
    evalSnapshotService,
    input.logger,
  );
  const evalRunService = new EvalRunService(
    evalRepository,
    new RetrievalPipelineEvalRunner(
      input.retrieval.retrievalPipeline,
      input.chat.chatGateway,
      input.llmCapabilityResolver,
      input.retrievalDefaultsProvider,
      input.chat.answerPresentation,
      input.skillSettingsResolver,
    ),
    new ChatGatewayLlmJudge(input.chat.chatGateway),
    input.chat.workbenchReplayRunner,
    input.logger,
    input.infrastructure.usageLimitPolicy,
    createLiveAgentConfigReader({ agentRepository: input.repositories.agentRepository }),
  );
  const evalSuiteService = new EvalSuiteService(evalRepository, evalRunService, input.logger);
  const revisionEvalRunRepository = new RevisionEvalRunRepository(input.infrastructure.database.kysely);
  const revisionEvalRunService = new RevisionEvalRunService({
    repository: revisionEvalRunRepository,
    revisions: {
      findRevisionByWorkspace: async ({ workspaceId, revisionId }) =>
        input.repositories.agentRevisionRepository.findRevisionByWorkspace({ workspaceId, revisionId }),
      findRevision: ({ workspaceId, agentId, revisionId }) =>
        input.repositories.agentRevisionRepository.findRevision(workspaceId, agentId, revisionId),
    },
    cases: evalRepository,
    contextCatalog: new ContextVariableRepository(input.infrastructure.database.kysely),
    runner: evalRunService,
    audit: input.infrastructure.auditService,
    logger: input.logger,
  });
  // Runs in the worker process, same as every other retention sweep: periodic maintenance with
  // no request behind it, so the HTTP process must not do it once per replica.
  const revisionEvalRunRetentionWorker = new TtlRetentionWorker({
    subject: "agent_revision_eval_run",
    sweep: { deleteBefore: (sweepInput) => revisionEvalRunRepository.deleteRunsUpdatedBefore(sweepInput) },
    audit: input.infrastructure.auditService,
    logger: input.logger,
    retentionDays: input.revisionEvalRunRetentionDays,
  });
  const customerReplyDelivery = new CustomerReplyDeliveryDispatcher({
    slack: new SlackCustomerReplyDeliverer({
      installations: input.repositories.slackInstallationRepository,
      installationService: input.integrations.slackInstallationService,
      persistence: new PostgresSlackConversationLinkLookup(input.infrastructure.database.kysely),
      slack: {
        conversationsOpen: async ({ users, botToken }) =>
          new SlackWebApiClient({ botToken }).conversationsOpen({ users }),
      },
      outbox: new ActionRequestRepository(input.infrastructure.database.kysely),
      logger: input.logger,
    }),
  });
  const operatorReplyService = new OperatorReplyService({
    conversationRepository: input.repositories.conversationRepository,
    messageRepository: input.repositories.messageRepository,
    auditService: input.infrastructure.auditService,
    publicConversationEventBus: input.publicConversationEventBus,
    customerReplyDelivery,
    publisher: input.workspaceInvalidationPublisher,
  });
  return {
    evalCaseService,
    evalMessageCaseService,
    evalRunService,
    revisionEvalRunService,
    revisionEvalRunRetentionWorker,
    evalSnapshotService,
    evalSuiteService,
    operatorReplyService,
  };
};
