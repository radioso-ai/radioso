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
  );
  const evalSuiteService = new EvalSuiteService(evalRepository, evalRunService, input.logger);
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
    evalSnapshotService,
    evalSuiteService,
    operatorReplyService,
  };
};
