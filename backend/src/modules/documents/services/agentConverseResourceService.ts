import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { DocumentRecord, DocumentRepositoryPort } from "./documentIngestionService.js";
import type { AgentConversePrincipal } from "../../settings/contracts/agentConverseSession.js";
import type { DocumentSourceContentService } from "./documentSourceContentService.js";
import type { AgentSourceScope } from "../../agents/public.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../domain/sourceConstants.js";
import { notFound, serviceUnavailable } from "../../../shared/domain/errors.js";

// Narrow, module-local audit port. The chat module owns the concrete AgentConverseAudit;
// this service depends only on the one method it calls, keeping cross-module wiring in
// composition rather than a deep import into chat internals.
interface ResourceReadAuditPort {
  recordResourceReadOutcome(input: {
    workspaceId: string;
    agentId: string;
    grantId: string;
    publicSessionId: string;
    status: "success" | "failure";
    reason?: string | null;
  }): Promise<void>;
}

const RESOURCE_URI_PREFIX = "radioso://agent-resource/";

export interface AgentConverseResourceSummary {
  uri: string;
  name: string;
  mimeType: string;
}

export interface AgentConverseResourceDetail extends AgentConverseResourceSummary {
  text: string;
}

const encodeResourceId = (documentId: string): string =>
  Buffer.from(documentId, "utf8").toString("base64url");

const decodeResourceId = (resourceId: string): string => {
  try {
    return Buffer.from(resourceId, "base64url").toString("utf8");
  } catch {
    throw notFound("Resource not found");
  }
};

export const agentConverseResourceUri = (documentId: string): string =>
  `${RESOURCE_URI_PREFIX}${encodeResourceId(documentId)}`;

export const agentConverseResourceIdFromUri = (uri: string): string | null =>
  uri.startsWith(RESOURCE_URI_PREFIX) ? uri.slice(RESOURCE_URI_PREFIX.length) : null;

const isVisibleInScope = (document: Pick<DocumentRecord, "sourceId">, sourceScope: AgentSourceScope): boolean => {
  if (sourceScope.mode === "all") {
    return true;
  }

  const sourceIds = new Set(sourceScope.sourceIds);
  if (document.sourceId) {
    return sourceIds.has(document.sourceId);
  }
  return sourceIds.has(MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);
};

const mimeTypeFor = (document: Pick<DocumentRecord, "sourceMimeType">): string =>
  document.sourceMimeType && document.sourceMimeType.trim().length > 0
    ? document.sourceMimeType
    : "text/markdown";

export class AgentConverseResourceService {
  constructor(
    private readonly dependencies: {
      agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
      documentRepository: Pick<DocumentRepositoryPort, "findByIdAndWorkspaceId" | "listByWorkspaceId">;
      documentSourceContentService: Pick<DocumentSourceContentService, "materialize">;
      audit?: ResourceReadAuditPort;
    },
  ) {}

  async list(principal: AgentConversePrincipal): Promise<AgentConverseResourceSummary[]> {
    const agent = await this.loadAgent(principal);
    const documents = await this.dependencies.documentRepository.listByWorkspaceId(principal.workspaceId);

    return documents
      .filter((document) => isVisibleInScope(document, agent.sourceScope))
      .map((document) => ({
        uri: agentConverseResourceUri(document.id),
        name: document.title,
        mimeType: mimeTypeFor(document),
      }));
  }

  async read(principal: AgentConversePrincipal, resourceId: string): Promise<AgentConverseResourceDetail> {
    const agent = await this.loadAgent(principal);
    const documentId = decodeResourceId(resourceId);
    const document = await this.dependencies.documentRepository.findByIdAndWorkspaceId(
      documentId,
      principal.workspaceId,
    );
    if (!document || !isVisibleInScope(document, agent.sourceScope)) {
      await this.recordRead(principal, "failure", "not_found");
      throw notFound("Resource not found");
    }

    try {
      const content = await this.dependencies.documentSourceContentService.materialize(document);
      await this.recordRead(principal, "success");
      return {
        uri: agentConverseResourceUri(document.id),
        name: document.title,
        mimeType: mimeTypeFor(document),
        text: content.markdownContent || content.sourceContent,
      };
    } catch (error) {
      await this.recordRead(principal, "failure", error instanceof Error ? error.name : "unknown");
      throw error;
    }
  }

  private async loadAgent(principal: AgentConversePrincipal) {
    const agent = await this.dependencies.agentRepository.findByIdAndWorkspaceId(
      principal.agentId,
      principal.workspaceId,
    );
    if (!agent) {
      throw serviceUnavailable("MCP converse agent is unavailable.", {
        code: "mcp_converse_agent_unavailable",
      });
    }
    return agent;
  }

  private async recordRead(
    principal: AgentConversePrincipal,
    status: "success" | "failure",
    reason?: string | null,
  ): Promise<void> {
    await this.dependencies.audit?.recordResourceReadOutcome({
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      grantId: principal.grantId,
      publicSessionId: principal.publicSessionId,
      status,
      reason,
    });
  }
}
