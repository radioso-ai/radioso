import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentConversePrincipal } from "../../settings/contracts/agentConverseSession.js";
import type { RetrievalAnswerService } from "./retrievalAnswerService.js";
import { serviceUnavailable } from "../../../shared/domain/errors.js";
import { resolveAgentRetrievalScope } from "../domain/agentRetrievalScope.js";

// Narrow, module-local audit port. The chat module owns the concrete AgentConverseAudit;
// this service depends only on the one method it calls, so the cross-module wiring stays in
// composition rather than a deep import into chat internals.
interface GroundedAnswerAuditPort {
  recordGroundedAnswerOutcome(input: {
    workspaceId: string;
    agentId: string;
    grantId: string;
    publicSessionId: string;
    status: "success" | "failure";
    citationCount?: number;
    reason?: string | null;
  }): Promise<void>;
}

export interface AgentConverseGroundedAnswerResult {
  answer: string;
  citations: unknown[];
  retrieval: {
    agentScoped: true;
  };
}

export class AgentConverseGroundedAnswerService {
  constructor(
    private readonly dependencies: {
      agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
      retrievalAnswerService: Pick<RetrievalAnswerService, "answer">;
      audit?: GroundedAnswerAuditPort;
    },
  ) {}

  async answer(
    principal: AgentConversePrincipal,
    input: { query: string; maxResults?: number },
  ): Promise<AgentConverseGroundedAnswerResult> {
    try {
      const agent = await this.dependencies.agentRepository.findByIdAndWorkspaceId(
        principal.agentId,
        principal.workspaceId,
      );
      if (!agent) {
        throw serviceUnavailable("MCP converse agent is unavailable.", {
          code: "mcp_converse_agent_unavailable",
        });
      }

      const result = await this.dependencies.retrievalAnswerService.answer({
        workspaceId: principal.workspaceId,
        query: input.query,
        ...resolveAgentRetrievalScope(agent),
        executionSurface: "mcp_capability",
      });

      // `maxResults` caps the number of citations returned to the caller (1..N). Retrieval
      // itself stays driven by the agent's configured top-k; this bounds the response.
      const visibleCitations = agent.citationDisplayEnabled ? result.citations ?? [] : [];
      const citations = typeof input.maxResults === "number" && input.maxResults > 0
        ? visibleCitations.slice(0, input.maxResults)
        : visibleCitations;

      await this.dependencies.audit?.recordGroundedAnswerOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: principal.grantId,
        publicSessionId: principal.publicSessionId,
        status: "success",
        citationCount: citations.length,
      });

      return {
        answer: result.answer,
        citations,
        retrieval: {
          agentScoped: true,
        },
      };
    } catch (error) {
      await this.dependencies.audit?.recordGroundedAnswerOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: principal.grantId,
        publicSessionId: principal.publicSessionId,
        status: "failure",
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }
}
