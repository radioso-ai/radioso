import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentConversePrincipal } from "../../settings/contracts/agentConverseSession.js";
import type { RetrievalAnswerService } from "./retrievalAnswerService.js";
import { serviceUnavailable } from "../../../shared/domain/errors.js";

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
    input: { query: string },
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
        sourceScope: agent.sourceScope,
        responseBehaviorEnabled: true,
        responseBehavior: {
          customInstruction: agent.customInstruction,
          citationDisplayEnabled: agent.citationDisplayEnabled,
        },
        agentSkillSettings: agent.skillSettings,
        executionSurface: "mcp_capability",
      });

      await this.dependencies.audit?.recordGroundedAnswerOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: principal.grantId,
        publicSessionId: principal.publicSessionId,
        status: "success",
        citationCount: result.citations?.length ?? 0,
      });

      return {
        answer: result.answer,
        citations: agent.citationDisplayEnabled ? result.citations ?? [] : [],
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
