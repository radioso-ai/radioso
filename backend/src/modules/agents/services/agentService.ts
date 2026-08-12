import type { AgentRepositoryPort, AgentUpdateOptions } from "../../../db/repositories/agentRepository.js";
import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AccessGrantService } from "../../accessGrants/public.js";
import type { AgentSkillRepositoryPort } from "../../agentSkills/public.js";
import { generateApiToken } from "../../auth/contracts/index.js";
import type { EmbedConfigCacheInvalidator } from "./embedConfigCacheInvalidator.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../documents/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import {
  getWebsiteEmbedSurfaceSettings,
  isAgentBootstrapActive,
  resolveEffectiveContactDelivery,
  type AgentInput,
  type AgentRecord,
} from "../domain.js";

export type AgentSettingsResource = Omit<AgentRecord, "authoredDirectives"> & {
  isDefault: boolean;
  assistantBootstrapActive: boolean;
};

export class AgentService {
  constructor(
    private readonly agentRepository: AgentRepositoryPort,
    private readonly workspaceRepository: Pick<WorkspaceRepositoryPort, "findById" | "updateGeneralSettings">,
    private readonly documentSourceRepository?: Pick<
      DocumentSourceRepositoryPort,
      "findExistingIdsByWorkspaceId" | "countDocumentsWithoutSource"
    >,
    private readonly embedConfigCacheInvalidator?: EmbedConfigCacheInvalidator,
    private readonly accessGrantService?: AccessGrantService,
    private readonly agentSkills?: Pick<AgentSkillRepositoryPort, "findByName">,
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
    const withSkillBackedFlags = async (agent: AgentRecord): Promise<AgentRecord> => {
      const notifySkill = await this.agentSkills?.findByName(workspaceId, agent.id, "contact_human");
      if (notifySkill?.kind !== "notify") {
        return agent;
      }
      return {
        ...agent,
        contactRequestsEnabled: notifySkill.enabled,
        // Resolve delivery from the same source dispatch sends to, so the contact
        // gate doesn't hide a working notify-skill destination behind a stale
        // legacy contactRequestDelivery (or vice versa).
        contactRequestDelivery: resolveEffectiveContactDelivery(notifySkill, agent.contactRequestDelivery),
      };
    };
    if (agentId) {
      const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
      if (!agent) {
        throw notFound("Agent not found");
      }
      return withSkillBackedFlags(agent);
    }
    return withSkillBackedFlags(await this.ensureDefaultAgent(workspaceId));
  }

  async create(workspaceId: string, input: AgentInput): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existingDefault = workspace.defaultAgentId
      ? await this.agentRepository.findByIdAndWorkspaceId(workspace.defaultAgentId, workspaceId)
      : await this.agentRepository.findDefaultByWorkspaceId(workspaceId);
    const agent = await this.agentRepository.create(workspaceId, input);
    await this.syncPublicLaunchGrants(null, agent);
    if (!existingDefault) {
      await this.agentRepository.setDefault(workspaceId, agent.id);
    }
    return this.present(agent, existingDefault?.id ?? agent.id);
  }

  async update(workspaceId: string, agentId: string, input: AgentInput, options?: AgentUpdateOptions): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existing = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!existing) {
      throw notFound("Agent not found");
    }
    const updated = await this.agentRepository.update(agentId, workspaceId, input, options);
    await this.syncPublicLaunchGrants(existing, updated);
    if (workspace.defaultAgentId === agentId) {
      await this.syncLegacyWorkspaceDefaults(workspace, updated);
    }
    // Drop the CDN-cached embed config so settings changes take effect now
    // rather than after the cache TTL. Best effort — the invalidator never
    // throws, and most deployments wire the no-op.
    const embedToken = getWebsiteEmbedSurfaceSettings(updated).token;
    if (embedToken && this.embedConfigCacheInvalidator) {
      await this.embedConfigCacheInvalidator.invalidateForToken(embedToken);
    }
    return this.present(updated, workspace.defaultAgentId);
  }

  async delete(workspaceId: string, agentId: string): Promise<void> {
    const workspace = await this.requireWorkspace(workspaceId);
    const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }

    const total = await this.agentRepository.countByWorkspaceId(workspaceId);
    if (total <= 1) {
      throw badRequest("Cannot delete the last agent in this workspace");
    }

    await this.agentRepository.deleteByIdAndWorkspaceId(agentId, workspaceId);

    if (workspace.defaultAgentId === agentId) {
      const remaining = await this.agentRepository.listByWorkspaceId(workspaceId);
      const nextDefault = remaining[0];
      if (nextDefault) {
        await this.agentRepository.setDefault(workspaceId, nextDefault.id);
        await this.syncLegacyWorkspaceDefaults(workspace, nextDefault);
      }
    }
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
    const agent = await this.agentRepository.create(workspaceId, {
      name: workspace.assistantName ?? "",
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
    await this.syncPublicLaunchGrants(null, agent);
    await this.agentRepository.setDefault(workspaceId, agent.id);
    return agent;
  }

  present(agent: AgentRecord, defaultAgentId?: string | null): AgentSettingsResource {
    const { authoredDirectives: _authoredDirectives, ...publicAgent } = agent;
    return {
      ...publicAgent,
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
      ? generateApiToken()
      : inputSurfaceSettings.anonymousChat?.token !== undefined
        ? inputSurfaceSettings.anonymousChat.token
        : publicChatTokenRequired && !currentAnonymousChat.token
          ? generateApiToken()
          : currentAnonymousChat.token;
    const websiteEmbedToken = input.rotateWebsiteEmbedToken
      ? generateApiToken()
      : inputSurfaceSettings.websiteEmbed?.token !== undefined
        ? inputSurfaceSettings.websiteEmbed.token
        : websiteEmbedEnabled && !currentWebsiteEmbed.token
          ? generateApiToken()
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
    const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
    await this.workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: agent.surfaceSettings.anonymousChat.enabled,
      anonymousChatToken: agent.surfaceSettings.anonymousChat.token,
      assistantName: agent.name,
      greetingInstruction: agent.greetingInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      websiteEmbedEnabled: websiteEmbed.enabled,
      websiteEmbedToken: websiteEmbed.token,
      websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
      websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
      websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
    });
  }

  private async syncPublicLaunchGrants(previous: AgentRecord | null, current: AgentRecord): Promise<void> {
    if (!this.accessGrantService) {
      return;
    }

    await this.syncPublicLaunchGrant({
      previousToken: previous?.surfaceSettings.anonymousChat.token ?? null,
      currentToken: current.surfaceSettings.anonymousChat.token,
      workspaceId: current.workspaceId,
      agentId: current.id,
      label: "anonymous-chat",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    const previousWebsiteEmbed = previous ? getWebsiteEmbedSurfaceSettings(previous) : null;
    const currentWebsiteEmbed = getWebsiteEmbedSurfaceSettings(current);
    await this.syncPublicLaunchGrant({
      previousToken: previousWebsiteEmbed?.token ?? null,
      currentToken: currentWebsiteEmbed.token,
      workspaceId: current.workspaceId,
      agentId: current.id,
      label: "website-embed",
      originConstraint: currentWebsiteEmbed.allowedOrigins.includes("*")
        ? { mode: "allow-all", origins: [] }
        : { mode: "list", origins: currentWebsiteEmbed.allowedOrigins },
    });
  }

  private async syncPublicLaunchGrant(input: {
    previousToken: string | null;
    currentToken: string | null;
    workspaceId: string;
    agentId: string;
    label: string;
    originConstraint: { mode: "allow-all"; origins: [] } | { mode: "list"; origins: string[] };
  }): Promise<void> {
    if (!this.accessGrantService || !input.currentToken) {
      return;
    }

    if (input.previousToken && input.previousToken !== input.currentToken) {
      const previousGrant = await this.accessGrantService.resolvePublicLaunchGrant(input.previousToken);
      if (previousGrant) {
        await this.accessGrantService.revokeGrant({
          grantId: previousGrant.id,
          reason: "surface_token_rotated",
        });
      }
    }

    const grant = await this.accessGrantService.resolveOrCreatePublicLaunchGrant({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      label: input.label,
      token: input.currentToken,
      originConstraint: input.originConstraint,
    });
    if (!grant.revokedAt) {
      await this.accessGrantService.updateGrantConstraints({
        grantId: grant.id,
        label: input.label,
        originConstraint: input.originConstraint,
        enabled: true,
      });
    }
  }
}
