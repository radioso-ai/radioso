import { notFound } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { RetrievalPipelineService, RewriteContinuityState } from "../../retrieval/public.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import { CHAT_TURN_ROUTE, ChatTurnIntentService, type ChatTurnRoute } from "./chatTurnIntentService.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";

type ChatIntentCapableRetrievalPipeline = Pick<RetrievalPipelineService, "run" | "interpret" | "runInterpreted" | "runWithoutRetrieval">;

interface ChatAnswerAuditMetadata {
  rewriteContinuityState?: RewriteContinuityState;
}

export interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  turnRoute: ChatTurnRoute;
  userMessage: MessageRecord;
  pageContext?: AssistantPageContext | null;
  priorRewriteContinuityState?: RewriteContinuityState;
}

export interface PrepareChatSessionInput {
  workspaceId: string;
  conversationId?: string;
  query: string;
  inputMetadata?: UserMessageInputMetadata;
  metadataFilter?: Record<string, unknown>;
  pageContext?: AssistantPageContext | null;
  sourceChannel?: string | null;
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
}

export class ChatSessionPreparer {
  private readonly chatTurnIntentService = new ChatTurnIntentService();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly auditService: AuditService,
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
  ) {}

  async prepare(input: PrepareChatSessionInput): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, input.anonymousSessionId)
      : null;
    const history = conversation
      ? await this.messageRepository.listRecentByConversationId(
          input.workspaceId,
          conversation.id,
          RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
        )
      : [];
    const rewriteContinuityState = conversation
      ? await this.loadRewriteContinuityState(input.workspaceId, conversation.id)
      : undefined;
    const responseIdentity = await this.resolveResponseIdentity(input.workspaceId);
    const pipelineInput = {
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity,
      responseBehaviorEnabled: true,
      metadataFilter: input.metadataFilter,
    };

    const retrievalPipeline = this.retrievalPipeline as ChatIntentCapableRetrievalPipeline;
    const interpretation = await retrievalPipeline.interpret(pipelineInput);
    const turnRoute = this.chatTurnIntentService.resolve({
      responseIntent: interpretation.interpretation.result.responseIntent,
    });
    const interpretedWithExecution = {
      ...interpretation,
      request: {
        ...interpretation.request,
        execution: {
          surface: "assistant" as const,
          path: turnRoute === CHAT_TURN_ROUTE.RETRIEVAL ? "assistant_retrieval" as const : "assistant_direct" as const,
          retrievalInvoked: turnRoute === CHAT_TURN_ROUTE.RETRIEVAL,
        },
      },
    };
    const retrieval = turnRoute === CHAT_TURN_ROUTE.RETRIEVAL
      ? await retrievalPipeline.runInterpreted(interpretedWithExecution)
      : await retrievalPipeline.runWithoutRetrieval(interpretedWithExecution);
    const persistedConversation =
      conversation ?? await this.conversationRepository.create(
        input.workspaceId,
        input.sourceChannel ?? null,
        input.anonymousSessionId ?? null,
        input.sourceOrigin ?? null,
      );

    const userMessage = await this.messageRepository.create({
      conversationId: persistedConversation.id,
      workspaceId: input.workspaceId,
      role: "user",
      content: input.query,
      inputMetadata: input.inputMetadata,
    });

    return {
      conversation: persistedConversation,
      history,
      retrieval,
      turnRoute,
      userMessage,
      pageContext: input.pageContext ?? null,
      priorRewriteContinuityState: rewriteContinuityState,
    };
  }

  private async resolveResponseIdentity(workspaceId: string): Promise<ResponseIdentity | null> {
    if (!this.workspaceRepository) {
      return null;
    }

    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      return null;
    }

    const name = workspace.assistantName.trim();
    return name
      ? {
          name,
        }
      : null;
  }

  private async ensureConversation(conversationId: string, workspaceId: string, anonymousSessionId?: string | null) {
    if (anonymousSessionId) {
      const conversation = await this.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        workspaceId,
        anonymousSessionId,
      );
      if (!conversation) {
        throw notFound("Conversation not found");
      }
      return conversation;
    }

    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    return conversation;
  }

  private async loadRewriteContinuityState(
    workspaceId: string,
    conversationId: string,
  ): Promise<RewriteContinuityState | undefined> {
    const metadata = await this.auditService.getLatestSuccessfulChatAnswerMetadata({
      workspaceId,
      conversationId,
    }) as ChatAnswerAuditMetadata | null;

    return normalizeRewriteContinuityState(metadata?.rewriteContinuityState);
  }
}
