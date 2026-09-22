import { serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AssistantChatService } from "./assistantChatService.js";
import type { AgentConversePrincipal } from "../../settings/contracts/agentConverseSession.js";
import type { AgentConverseAudit } from "./agentConverseAudit.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { ChatCitation } from "../contracts/answerTypes.js";
import type { AgentToolCatalogPort } from "../contracts/routineInvocation.js";
import { buildAgentReplyEnvelope, isChatTurnResponse, type AgentReplyEnvelopeCore } from "./agentReplyEnvelope.js";
import { chatRequestInputFor, resolveAgentTurnInput, type AgentTurnInputBody } from "./agentTurnInput.js";

/**
 * Verifies the caller-supplied visitor token against this converse session. The MCP
 * surface has no browser origin to bind to, so the session's `publicSessionId` is the
 * binding; a token that does not match it leaves the turn anonymous rather than failing.
 */
export interface ConverseVisitorIdentityVerifier {
  verify(input: {
    token: string;
    workspaceId: string;
    agentId: string;
    boundSessionId: string;
  }): Promise<{ customerId: string; attributes: Record<string, unknown> } | null>;
}

/** One agent-facing turn: the turn input, plus an optional signed visitor identity. */
interface AgentConverseTurnBody extends AgentTurnInputBody {
  signedIdentity?: string;
}

interface AgentConverseConversationStore {
  getOrCreateByAnonymousSession?(input: {
    workspaceId: string;
    agentId: string;
    sourceChannel: string;
    anonymousSessionId: string;
    sourceOrigin?: string | null;
  }): Promise<{ record: { id: string; agentRevisionId?: string | null }; created: boolean }>;
}

/**
 * The MCP `ask` reply: the agent reply envelope core plus the answer in this
 * route's own layout. `conversationId` is the caller's public session id, the
 * handle it exchanged for, never the conversation row id.
 */
export interface AgentConverseAskResult extends AgentReplyEnvelopeCore {
  answer: {
    text: string;
    citations: ChatCitation[];
  };
}

/** Only a credential-bound session names a grant; a walk-in one has none. */
const converseGrantId = (principal: AgentConversePrincipal): string | null =>
  principal.origin.kind === "grant" ? principal.origin.grantId : null;

export class AgentConverseService {
  constructor(
    private readonly dependencies: {
      assistantChatService: Pick<AssistantChatService, "answer">;
      conversationRepository: AgentConverseConversationStore;
      agentToolCatalog: AgentToolCatalogPort;
      audit?: AgentConverseAudit;
      visitorIdentity?: ConverseVisitorIdentityVerifier;
      publisher?: WorkspaceInvalidationPublisher;
      metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
      logger?: Pick<AppLogger, "info">;
    },
  ) {}

  /**
   * Binds the session's conversation first so a tool call is validated against
   * the release that conversation is pinned to — the one the turn will run on —
   * and only then runs the turn. A conversation not yet pinned (first turn)
   * resolves against the current release, which is what the turn pins it to.
   */
  async askAgent(principal: AgentConversePrincipal, body: AgentConverseTurnBody): Promise<AgentConverseAskResult> {
    try {
      const getOrCreateConversation =
        this.dependencies.conversationRepository.getOrCreateByAnonymousSession?.bind(
          this.dependencies.conversationRepository,
        );
      if (!getOrCreateConversation) {
        throw serviceUnavailable("MCP converse conversation binding is unavailable.", {
          code: "mcp_converse_conversation_binding_unavailable",
        });
      }
      const conversation = await getOrCreateConversation({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        sourceChannel: "mcp",
        anonymousSessionId: principal.publicSessionId,
        sourceOrigin: null,
      });
      if (conversation.created) {
        this.dependencies.publisher?.enqueue(principal.workspaceId, ["conversation.created"]);
      }
      const input = await resolveAgentTurnInput(this.dependencies.agentToolCatalog, {
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        ...(conversation.record.agentRevisionId ? { agentRevisionId: conversation.record.agentRevisionId } : {}),
        body,
      }, { metrics: this.dependencies.metrics, logger: this.dependencies.logger });
      const verifiedIdentity = await this.verifyVisitorIdentity(principal, body.signedIdentity);
      const response = await this.dependencies.assistantChatService.answer({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        ...chatRequestInputFor(input),
        stream: false,
        conversationId: conversation.record.id,
        anonymousSessionId: principal.publicSessionId,
        sourceChannel: "mcp",
        sourceOrigin: null,
        verifiedCustomerId: verifiedIdentity?.customerId,
        verifiedIdentity: verifiedIdentity
          ? { customerId: verifiedIdentity.customerId, ...verifiedIdentity.attributes }
          : undefined,
      });
      // The converse route always runs a turn (a message or a tool call), never
      // `startConversation`, so the reply is a completed turn; a missing turn or
      // conversation is a fault.
      if (!response || !isChatTurnResponse(response)) {
        throw serviceUnavailable("MCP converse response is unavailable.", {
          code: "mcp_converse_empty_response",
        });
      }

      await this.dependencies.audit?.recordAskOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: converseGrantId(principal),
        publicSessionId: principal.publicSessionId,
        status: "success",
      });

      return {
        ...buildAgentReplyEnvelope(response),
        conversationId: principal.publicSessionId,
        answer: {
          text: response.answer,
          citations: response.citations ?? [],
        },
      };
    } catch (error) {
      await this.dependencies.audit?.recordAskOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: converseGrantId(principal),
        publicSessionId: principal.publicSessionId,
        status: "failure",
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }

  /**
   * A mismatched or unverifiable token leaves the turn anonymous with no error, exactly
   * as the embed path treats one (spec 1290 edge case).
   */
  private async verifyVisitorIdentity(
    principal: AgentConversePrincipal,
    token: string | undefined,
  ): Promise<{ customerId: string; attributes: Record<string, unknown> } | null> {
    if (!token || !this.dependencies.visitorIdentity) {
      return null;
    }
    try {
      return await this.dependencies.visitorIdentity.verify({
        token,
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        boundSessionId: principal.publicSessionId,
      });
    } catch {
      return null;
    }
  }
}
