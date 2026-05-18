import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { getWebsiteEmbedSurfaceSettings, isAgentBootstrapActive } from "../../agents/public.js";
import { buildPublicAssistantLogoUrl } from "../../../app/http/shared/assistantLogoUrl.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { RetrievalSettingsRecord } from "../domain/retrievalSettings.js";
import { validateRetrievalSettings } from "../domain/retrievalSettings.js";
import { validateWebsiteEmbedSettings } from "../domain/websiteEmbedSettings.js";
import {
  DefaultWebsiteEmbedIntegrationProvider,
  type WebsiteEmbedIntegrationProvider,
} from "../domain/websiteEmbedIntegration.js";
import type {
  PlatformChannelsSettingsSection,
  PlatformRetrievalSettingsSection,
  PlatformSettingsPatch,
  PlatformSettingsResource,
} from "../domain/platformSettings.js";
import type { RetrievalSettingsService } from "../contracts/services.js";

export interface PlatformSettingsServiceDependencies {
  workspaceRepository: Pick<WorkspaceRepositoryPort, "findById">;
  agentService: Pick<AgentService, "resolve" | "update" | "withRotatedTokens">;
  retrievalSettingsService: Pick<
    RetrievalSettingsService,
    "getForWorkspace" | "listMetadataFieldSuggestions" | "updateForWorkspace"
  >;
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
    const [workspace, retrievalSettings, metadataFieldSuggestions] = await Promise.all([
      this.dependencies.workspaceRepository.findById(workspaceId),
      this.dependencies.retrievalSettingsService.getForWorkspace(workspaceId),
      this.dependencies.retrievalSettingsService.listMetadataFieldSuggestions(workspaceId),
    ]);

    if (!workspace) {
      throw notFound("Workspace not found");
    }
    const agent = await this.dependencies.agentService.resolve(workspaceId);

    return {
      assistant: this.buildAssistantSection(agent),
      retrieval: this.buildRetrievalSection(retrievalSettings, metadataFieldSuggestions),
      channels: this.buildChannelsSection(agent, workspace),
    };
  }

  async updateForWorkspace(
    workspaceId: string,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext = {},
  ): Promise<PlatformSettingsResource> {
    const [workspace, retrievalSettings] = await Promise.all([
      this.dependencies.workspaceRepository.findById(workspaceId),
      this.dependencies.retrievalSettingsService.getForWorkspace(workspaceId),
    ]);

    if (!workspace) {
      throw notFound("Workspace not found");
    }

    let currentAgent = await this.dependencies.agentService.resolve(workspaceId);
    let currentRetrievalSettings = retrievalSettings;

    if (patch.assistant || patch.channels) {
      currentAgent = await this.updateAgentSections(workspaceId, currentAgent, workspace, patch, context);
    }

    if (this.hasRetrievalSettingsPatch(patch)) {
      currentRetrievalSettings = await this.updateRetrievalSections(
        workspaceId,
        currentRetrievalSettings,
        patch,
      );
    }

    const metadataFieldSuggestions = await this.dependencies.retrievalSettingsService.listMetadataFieldSuggestions(workspaceId);

    return {
      assistant: this.buildAssistantSection(currentAgent),
      retrieval: this.buildRetrievalSection(currentRetrievalSettings, metadataFieldSuggestions),
      channels: this.buildChannelsSection(currentAgent, workspace),
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
      rotateAnonymousChatToken: channels.rotateAnonymousChatToken,
      name: assistant.assistantName ?? agent.name,
      greetingInstruction: assistant.greetingInstruction ?? agent.greetingInstruction,
      assistantDefaultLocale:
        assistant.assistantDefaultLocale === undefined
          ? agent.assistantDefaultLocale
          : assistant.assistantDefaultLocale,
      proactiveGreetingEnabled: assistant.proactiveGreetingEnabled ?? agent.proactiveGreetingEnabled,
      suggestedQuestionsEnabled: assistant.suggestedQuestionsEnabled ?? agent.suggestedQuestionsEnabled,
      customInstruction: assistant.customInstruction ?? agent.customInstruction,
      rotateWebsiteEmbedToken: channels.rotateWebsiteEmbedToken,
    }));

    await this.recordChannelAuditEvents({
      accountId: context.accountId,
      workspaceId,
      previousAgent: agent,
      anonymousChatEnabled,
      rotateAnonymousChatToken: channels.rotateAnonymousChatToken ?? false,
      websiteEmbedEnabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
      rotateWebsiteEmbedToken: channels.rotateWebsiteEmbedToken ?? false,
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

  private async updateRetrievalSections(
    workspaceId: string,
    existing: RetrievalSettingsRecord,
    patch: PlatformSettingsPatch,
  ): Promise<RetrievalSettingsRecord> {
    const retrieval = patch.retrieval ?? {};
    const next = validateRetrievalSettings({
      ...existing,
      queryRewriteEnabled: retrieval.queryRewriteEnabled ?? existing.queryRewriteEnabled,
      semanticRewriteInstructions: retrieval.semanticRewriteInstructions ?? existing.semanticRewriteInstructions,
      lexicalRewriteInstructions: retrieval.lexicalRewriteInstructions ?? existing.lexicalRewriteInstructions,
      suggestedQuestionsEnabled: existing.suggestedQuestionsEnabled,
      suggestedQuestionsCount: existing.suggestedQuestionsCount,
      rerankEnabled: retrieval.rerankEnabled ?? existing.rerankEnabled,
      vectorTopK: retrieval.vectorTopK ?? existing.vectorTopK,
      similarityThreshold: retrieval.similarityThreshold ?? existing.similarityThreshold,
      rerankTopK: retrieval.rerankTopK ?? existing.rerankTopK,
      citationDisplayEnabled: retrieval.citationDisplayEnabled ?? existing.citationDisplayEnabled,
      answerSupportValidationEnabled:
        retrieval.answerSupportValidationEnabled ?? existing.answerSupportValidationEnabled,
      metadataRules: retrieval.metadataRules ?? existing.metadataRules,
      customInstruction: existing.customInstruction,
    });

    return (await this.dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, next)) ?? {
      ...existing,
      ...next,
    };
  }

  private hasRetrievalSettingsPatch(patch: PlatformSettingsPatch): boolean {
    return Boolean(patch.retrieval);
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

  private buildRetrievalSection(
    settings: RetrievalSettingsRecord,
    metadataFieldSuggestions: PlatformRetrievalSettingsSection["metadataFieldSuggestions"],
  ): PlatformRetrievalSettingsSection {
    return {
      queryRewriteEnabled: settings.queryRewriteEnabled,
      semanticRewriteInstructions: settings.semanticRewriteInstructions,
      lexicalRewriteInstructions: settings.lexicalRewriteInstructions,
      rerankEnabled: settings.rerankEnabled,
      vectorTopK: settings.vectorTopK,
      similarityThreshold: settings.similarityThreshold,
      rerankTopK: settings.rerankTopK,
      citationDisplayEnabled: settings.citationDisplayEnabled,
      answerSupportValidationEnabled: settings.answerSupportValidationEnabled ?? true,
      metadataRules: settings.metadataRules,
      metadataFieldSuggestions,
    };
  }

  private buildChannelsSection(agent: AgentRecord, workspace: WorkspaceRecord): PlatformChannelsSettingsSection {
    const anonymousChat = agent.surfaceSettings.anonymousChat;
    const websiteEmbed = agent.surfaceSettings.websiteEmbed;
    return {
      anonymousChatEnabled: anonymousChat.enabled,
      anonymousChatUrl: this.buildAnonymousChatUrl(anonymousChat.token, anonymousChat.enabled),
      websiteEmbedEnabled: websiteEmbed.enabled,
      websiteEmbedToken: websiteEmbed.token,
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
