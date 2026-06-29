import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AccessGrantService } from "../../accessGrants/public.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { getWebsiteEmbedSurfaceSettings, isAgentBootstrapActive } from "../../agents/public.js";
import { buildAssistantLogoCacheKey, buildPublicAssistantLogoUrl } from "../../../app/http/shared/assistantLogoUrl.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { validateWebsiteEmbedSettings } from "../domain/websiteEmbedSettings.js";
import {
  DefaultWebsiteEmbedIntegrationProvider,
  type WebsiteEmbedIntegrationProvider,
} from "../domain/websiteEmbedIntegration.js";
import type {
  PlatformChannelsSettingsSection,
  PlatformSettingsPatch,
  PlatformSettingsResource,
} from "../domain/platformSettings.js";
import { resolvePublicLaunchLifecycle } from "../../accessGrants/public.js";

export interface PlatformSettingsServiceDependencies {
  workspaceRepository: Pick<WorkspaceRepositoryPort, "findById">;
  agentService: Pick<AgentService, "resolve" | "update" | "withRotatedTokens">;
  accessGrantService?: Pick<AccessGrantService, "resolvePublicLaunchGrant">;
  auditService?: Pick<AuditService, "record">;
  publicChatBaseUrl?: string;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
}

export interface PlatformSettingsUpdateContext {
  accountId?: string | null;
}

export class PlatformSettingsService {
  constructor(private readonly dependencies: PlatformSettingsServiceDependencies) {}

  private get websiteEmbedIntegration(): WebsiteEmbedIntegrationProvider {
    return this.dependencies.websiteEmbedIntegration
      ?? new DefaultWebsiteEmbedIntegrationProvider();
  }

  async getForWorkspace(workspaceId: string): Promise<PlatformSettingsResource> {
    const workspace = await this.dependencies.workspaceRepository.findById(workspaceId);

    if (!workspace) {
      throw notFound("Workspace not found");
    }
    const agent = await this.dependencies.agentService.resolve(workspaceId);

    return {
      assistant: this.buildAssistantSection(agent),
      channels: await this.buildChannelsSection(agent, workspace),
    };
  }

  async updateForWorkspace(
    workspaceId: string,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext = {},
  ): Promise<PlatformSettingsResource> {
    const workspace = await this.dependencies.workspaceRepository.findById(workspaceId);

    if (!workspace) {
      throw notFound("Workspace not found");
    }

    let currentAgent = await this.dependencies.agentService.resolve(workspaceId);

    if (patch.assistant || patch.channels) {
      currentAgent = await this.updateAgentSections(workspaceId, currentAgent, workspace, patch, context);
    }

    return {
      assistant: this.buildAssistantSection(currentAgent),
      channels: await this.buildChannelsSection(currentAgent, workspace),
    };
  }

  private async updateAgentSections(
    workspaceId: string,
    agent: AgentRecord,
    _workspace: WorkspaceRecord,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext,
  ): Promise<AgentRecord> {
    const channels = patch.channels ?? {};
    const assistant = patch.assistant ?? {};
    const anonymousChat = agent.surfaceSettings.anonymousChat;
    const websiteEmbed = agent.surfaceSettings.websiteEmbed;
    const anonymousChatEnabled = channels.anonymousChatEnabled ?? anonymousChat.enabled;
    const rotateAnonymousChatToken = channels.rotateAnonymousChatToken;
    const rotateWebsiteEmbedToken = channels.rotateWebsiteEmbedToken;

    let normalizedWebsiteEmbed;
    try {
      normalizedWebsiteEmbed = validateWebsiteEmbedSettings({
        websiteEmbedEnabled: channels.websiteEmbedEnabled ?? websiteEmbed.enabled,
        websiteEmbedToken: websiteEmbed.token,
        websiteEmbedAllowedOrigins: channels.websiteEmbedAllowedOrigins ?? websiteEmbed.allowedOrigins,
        websiteEmbedLauncherLabel: channels.websiteEmbedLauncherLabel ?? websiteEmbed.launcherLabel,
        websiteEmbedLauncherPosition: channels.websiteEmbedLauncherPosition ?? websiteEmbed.launcherPosition,
        websiteEmbedTheme: channels.websiteEmbedTheme ?? websiteEmbed.theme,
        websiteEmbedCopy: channels.websiteEmbedCopy ?? websiteEmbed.copy,
        websiteEmbedExpertOverrides: channels.websiteEmbedExpertOverrides ?? websiteEmbed.expertOverrides,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw badRequest(error.message);
      }
      throw error;
    }

    const updated = await this.dependencies.agentService.update(workspaceId, agent.id, this.dependencies.agentService.withRotatedTokens(agent, {
      surfaceSettings: {
        anonymousChat: {
          enabled: anonymousChatEnabled,
        },
        websiteEmbed: {
          enabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
          allowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
          launcherLabel: normalizedWebsiteEmbed.websiteEmbedLauncherLabel,
          launcherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
          theme: normalizedWebsiteEmbed.websiteEmbedTheme,
          copy: normalizedWebsiteEmbed.websiteEmbedCopy,
          expertOverrides: normalizedWebsiteEmbed.websiteEmbedExpertOverrides,
        },
      },
      rotateAnonymousChatToken,
      name: assistant.assistantName ?? agent.name,
      greetingInstruction: assistant.greetingInstruction ?? agent.greetingInstruction,
      assistantDefaultLocale:
        assistant.assistantDefaultLocale === undefined
          ? agent.assistantDefaultLocale
          : assistant.assistantDefaultLocale,
      proactiveGreetingEnabled: assistant.proactiveGreetingEnabled ?? agent.proactiveGreetingEnabled,
      suggestedQuestionsEnabled: assistant.suggestedQuestionsEnabled ?? agent.suggestedQuestionsEnabled,
      customInstruction: assistant.customInstruction ?? agent.customInstruction,
      rotateWebsiteEmbedToken,
    }));

    await this.recordChannelAuditEvents({
      accountId: context.accountId,
      workspaceId,
      previousAgent: agent,
      anonymousChatEnabled,
      rotateAnonymousChatToken: rotateAnonymousChatToken ?? false,
      websiteEmbedEnabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
      rotateWebsiteEmbedToken: rotateWebsiteEmbedToken ?? false,
    });

    return updated;
  }

  private async recordChannelAuditEvents(input: {
    accountId?: string | null;
    workspaceId: string;
    previousAgent: AgentRecord;
    anonymousChatEnabled: boolean;
    rotateAnonymousChatToken: boolean;
    websiteEmbedEnabled: boolean;
    websiteEmbedAllowedOrigins: string[];
    websiteEmbedLauncherPosition: AgentRecord["surfaceSettings"]["websiteEmbed"]["launcherPosition"];
    rotateWebsiteEmbedToken: boolean;
  }): Promise<void> {
    const auditService = this.dependencies.auditService;
    if (!auditService) {
      return;
    }

    if (input.anonymousChatEnabled !== input.previousAgent.surfaceSettings.anonymousChat.enabled) {
      await auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.anonymousChatEnabled ? "anonymous_chat.enabled" : "anonymous_chat.disabled",
        eventStatus: "success",
        metadata: {},
      });
    }

    if (input.rotateAnonymousChatToken) {
      await auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "anonymous_chat.token_rotated",
        eventStatus: "success",
        metadata: { enabled: input.anonymousChatEnabled },
      });
    }

    if (input.websiteEmbedEnabled !== getWebsiteEmbedSurfaceSettings(input.previousAgent).enabled) {
      await auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.websiteEmbedEnabled ? "website_embed.enabled" : "website_embed.disabled",
        eventStatus: "success",
        metadata: {
          allowedOrigins: input.websiteEmbedAllowedOrigins,
          launcherPosition: input.websiteEmbedLauncherPosition,
        },
      });
    }

    if (input.rotateWebsiteEmbedToken) {
      await auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "website_embed.token_rotated",
        eventStatus: "success",
        metadata: {
          enabled: input.websiteEmbedEnabled,
          allowedOrigins: input.websiteEmbedAllowedOrigins,
        },
      });
    }
  }

  private buildAssistantSection(agent: AgentRecord) {
    return {
      assistantName: agent.name,
      greetingInstruction: agent.greetingInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      assistantBootstrapActive: isAgentBootstrapActive(agent),
      suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
      customInstruction: agent.customInstruction,
      assistantLogoUrl: this.buildAssistantLogoUrl(agent),
    };
  }

  private async buildChannelsSection(agent: AgentRecord, workspace: WorkspaceRecord): Promise<PlatformChannelsSettingsSection> {
    const anonymousChat = agent.surfaceSettings.anonymousChat;
    const websiteEmbed = agent.surfaceSettings.websiteEmbed;
    const [anonymousChatLifecycle, websiteEmbedLifecycle] = await Promise.all([
      resolvePublicLaunchLifecycle(anonymousChat.token, this.dependencies.accessGrantService),
      resolvePublicLaunchLifecycle(websiteEmbed.token, this.dependencies.accessGrantService),
    ]);
    return {
      anonymousChatEnabled: anonymousChat.enabled,
      anonymousChatUrl: this.buildAnonymousChatUrl(anonymousChat.token, anonymousChat.enabled),
      anonymousChatLastUsedAt: anonymousChatLifecycle.lastUsedAt,
      websiteEmbedEnabled: websiteEmbed.enabled,
      websiteEmbedToken: websiteEmbed.token,
      websiteEmbedLastUsedAt: websiteEmbedLifecycle.lastUsedAt,
      websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
      websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
      websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
      websiteEmbedTheme: websiteEmbed.theme,
      websiteEmbedCopy: websiteEmbed.copy,
      websiteEmbedExpertOverrides: websiteEmbed.expertOverrides,
      websiteEmbedScriptUrl: this.websiteEmbedIntegration.buildScriptUrl(),
      websiteEmbedSnippet: this.websiteEmbedIntegration.buildSnippet({
        name: workspace.name,
        assistantName: agent.name,
        websiteEmbedEnabled: websiteEmbed.enabled,
        websiteEmbedToken: websiteEmbed.token,
        websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
        websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
        websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
      }),
    };
  }

  private buildAssistantLogoUrl(agent: AgentRecord): string | null {
    const token = agent.surfaceSettings.anonymousChat.token ?? getWebsiteEmbedSurfaceSettings(agent).token;
    return buildPublicAssistantLogoUrl({
      token,
      hasLogo: Boolean(agent.logo),
      cacheKey: buildAssistantLogoCacheKey(agent.logo),
      publicChatBaseUrl: this.dependencies.publicChatBaseUrl,
    });
  }

  private buildAnonymousChatUrl(token: string | null, enabled: boolean): string | null {
    const baseUrl = this.dependencies.publicChatBaseUrl;
    if (!baseUrl || !enabled || !token) {
      return null;
    }
    return `${baseUrl}/${token}`;
  }

}
