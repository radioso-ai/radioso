import { randomBytes } from "node:crypto";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { RetrievalSettingsService } from "../../settings/contracts/services.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../documents/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import {
  isAgentBootstrapActive,
  type AgentInput,
  type AgentRecord,
} from "../domain.js";

export type AgentSettingsResource = AgentRecord & {
  isDefault: boolean;
  assistantBootstrapActive: boolean;
};

export class AgentService {
  constructor(
    private readonly agentRepository: AgentRepositoryPort,
    private readonly workspaceRepository: Pick<WorkspaceRepositoryPort, "findById" | "updateGeneralSettings">,
    private readonly retrievalSettingsService: Pick<RetrievalSettingsService, "getForWorkspace">,
    private readonly documentSourceRepository?: Pick<
      DocumentSourceRepositoryPort,
      "findExistingIdsByWorkspaceId" | "countDocumentsWithoutSource"
    >,
  ) {}

  async list(workspaceId: string): Promise<AgentSettingsResource[]> {
    const [workspace, agents] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.agentRepository.listByWorkspaceId(workspaceId),
    ]);
    const list = agents.length > 0 ? agents : [await this.ensureDefaultAgent(workspaceId)];
    const defaultAgentId = workspace.defaultAgentId ?? (agents.length === 0 ? list[0]?.id : null);
    return list.map((agent) => this.present(agent, defaultAgentId));
  }

  async get(workspaceId: string, agentId: string): Promise<AgentSettingsResource> {
    const [workspace, agent] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId),
    ]);
    if (!agent) {
      throw notFound("Agent not found");
    }
    return this.present(agent, workspace.defaultAgentId);
  }

  async resolve(workspaceId: string, agentId?: string | null): Promise<AgentRecord> {
    if (agentId) {
      const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
      if (!agent) {
        throw notFound("Agent not found");
      }
      return agent;
    }
    return this.ensureDefaultAgent(workspaceId);
  }

  async create(workspaceId: string, input: AgentInput): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existingDefault = workspace.defaultAgentId
      ? await this.agentRepository.findByIdAndWorkspaceId(workspace.defaultAgentId, workspaceId)
      : await this.agentRepository.findDefaultByWorkspaceId(workspaceId);
    const agent = await this.agentRepository.create(workspaceId, input);
    if (!existingDefault) {
      await this.agentRepository.setDefault(workspaceId, agent.id);
    }
    return this.present(agent, existingDefault?.id ?? agent.id);
  }

  async update(workspaceId: string, agentId: string, input: AgentInput): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existing = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!existing) {
      throw notFound("Agent not found");
    }
    const updated = await this.agentRepository.update(agentId, workspaceId, input);
    if (workspace.defaultAgentId === agentId) {
      await this.syncLegacyWorkspaceDefaults(workspace, updated);
    }
    return this.present(updated, workspace.defaultAgentId);
  }

  async setDefault(workspaceId: string, agentId: string): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    await this.agentRepository.setDefault(workspaceId, agentId);
    await this.syncLegacyWorkspaceDefaults(workspace, agent);
    return this.present(agent, agentId);
  }

  async ensureDefaultAgent(workspaceId: string): Promise<AgentRecord> {
    const workspace = await this.requireWorkspace(workspaceId);
    const existing = await this.agentRepository.findDefaultByWorkspaceId(workspaceId);
    if (existing) {
      return existing;
    }
    const settings = await this.retrievalSettingsService.getForWorkspace(workspaceId);
    const agent = await this.agentRepository.create(workspaceId, {
      name: workspace.assistantName ?? "",
      customInstruction: settings.customInstruction,
      suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      greetingInstruction: workspace.greetingInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
      surfaceSettings: {
        authenticatedChat: {
          enabled: true,
        },
        anonymousChat: {
          enabled: workspace.anonymousChatEnabled,
          token: workspace.anonymousChatToken,
        },
        websiteEmbed: {
          enabled: workspace.websiteEmbedEnabled,
          token: workspace.websiteEmbedToken,
          allowedOrigins: workspace.websiteEmbedAllowedOrigins,
          launcherLabel: workspace.websiteEmbedLauncherLabel,
          launcherPosition: workspace.websiteEmbedLauncherPosition,
        },
      },
    });
    await this.agentRepository.setDefault(workspaceId, agent.id);
    return agent;
  }

  present(agent: AgentRecord, defaultAgentId?: string | null): AgentSettingsResource {
    return {
      ...agent,
      isDefault: defaultAgentId === agent.id,
      assistantBootstrapActive: isAgentBootstrapActive(agent),
    };
  }

  withRotatedTokens(agent: AgentRecord, input: AgentInput & {
    rotateAnonymousChatToken?: boolean;
    rotateWebsiteEmbedToken?: boolean;
  }): AgentInput {
    const inputSurfaceSettings = input.surfaceSettings ?? {};
    const currentAnonymousChat = agent.surfaceSettings.anonymousChat;
    const currentWebsiteEmbed = agent.surfaceSettings.websiteEmbed;
    const anonymousChatEnabled = inputSurfaceSettings.anonymousChat?.enabled ?? currentAnonymousChat.enabled;
    const websiteEmbedEnabled = inputSurfaceSettings.websiteEmbed?.enabled ?? currentWebsiteEmbed.enabled;
    const publicChatTokenRequired = anonymousChatEnabled || websiteEmbedEnabled;
    const anonymousChatToken = input.rotateAnonymousChatToken
      ? randomBytes(16).toString("base64url")
      : inputSurfaceSettings.anonymousChat?.token !== undefined
        ? inputSurfaceSettings.anonymousChat.token
        : publicChatTokenRequired && !currentAnonymousChat.token
          ? randomBytes(16).toString("base64url")
          : currentAnonymousChat.token;
    const websiteEmbedToken = input.rotateWebsiteEmbedToken
      ? randomBytes(16).toString("base64url")
      : inputSurfaceSettings.websiteEmbed?.token !== undefined
        ? inputSurfaceSettings.websiteEmbed.token
        : websiteEmbedEnabled && !currentWebsiteEmbed.token
          ? randomBytes(16).toString("base64url")
          : currentWebsiteEmbed.token;

    return {
      ...input,
      surfaceSettings: {
        ...inputSurfaceSettings,
        anonymousChat: {
          ...inputSurfaceSettings.anonymousChat,
          enabled: anonymousChatEnabled,
          token: anonymousChatToken,
        },
        websiteEmbed: {
          ...inputSurfaceSettings.websiteEmbed,
          enabled: websiteEmbedEnabled,
          token: websiteEmbedToken,
        },
      },
    };
  }

  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      throw notFound("Workspace not found");
    }
    return workspace;
  }

  private async validateSourceScope(workspaceId: string, input: AgentInput): Promise<void> {
    if (input.sourceScope?.mode !== "selected") {
      return;
    }
    if (!this.documentSourceRepository) {
      throw badRequest("Document sources are not configured");
    }
    const sourceIds = input.sourceScope.sourceIds;
    const hasManualSourceIds = sourceIds.includes(MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);
    const sourceIdsToValidate = sourceIds.filter((sourceId) => sourceId !== MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);

    if (sourceIdsToValidate.length === 0 && !hasManualSourceIds) {
      return;
    }

    const existingIds = new Set(await this.documentSourceRepository.findExistingIdsByWorkspaceId(workspaceId, sourceIdsToValidate));
    const missingSourceId = sourceIdsToValidate.find((sourceId) => !existingIds.has(sourceId));
    if (missingSourceId) {
      throw badRequest("sourceScope.sourceIds contains a source that does not belong to this workspace");
    }

    if (!hasManualSourceIds) {
      return;
    }

    const documentsWithoutSourceCount = await this.documentSourceRepository.countDocumentsWithoutSource(workspaceId);
    if (documentsWithoutSourceCount === 0) {
      throw badRequest("sourceScope.sourceIds contains a source that does not belong to this workspace");
    }
  }

  private async syncLegacyWorkspaceDefaults(workspace: WorkspaceRecord, agent: AgentRecord): Promise<void> {
    await this.workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: agent.surfaceSettings.anonymousChat.enabled,
      anonymousChatToken: agent.surfaceSettings.anonymousChat.token,
      assistantName: agent.name,
      greetingInstruction: agent.greetingInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      websiteEmbedEnabled: agent.surfaceSettings.websiteEmbed.enabled,
      websiteEmbedToken: agent.surfaceSettings.websiteEmbed.token,
      websiteEmbedAllowedOrigins: agent.surfaceSettings.websiteEmbed.allowedOrigins,
      websiteEmbedLauncherLabel: agent.surfaceSettings.websiteEmbed.launcherLabel,
      websiteEmbedLauncherPosition: agent.surfaceSettings.websiteEmbed.launcherPosition,
    });
  }
}
