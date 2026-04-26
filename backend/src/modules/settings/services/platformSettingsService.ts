import { randomBytes } from "node:crypto";

import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/services/auditService.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { buildAssistantSettingsSection } from "../domain/assistantSettings.js";
import {
  isAssistantBootstrapActive,
  resolveAssistantDisplayName,
  validateAssistantBootstrapSettings,
} from "../domain/assistantBootstrapSettings.js";
import type { RetrievalSettingsRecord } from "../domain/retrievalSettings.js";
import { validateRetrievalSettings } from "../domain/retrievalSettings.js";
import {
  DEFAULT_WEBSITE_EMBED_SCRIPT_PATH,
  validateWebsiteEmbedSettings,
} from "../domain/websiteEmbedSettings.js";
import type {
  PlatformChannelsSettingsSection,
  PlatformRetrievalSettingsSection,
  PlatformSettingsPatch,
  PlatformSettingsResource,
} from "../domain/platformSettings.js";
import type { RetrievalSettingsService } from "./retrievalSettingsService.js";

export interface PlatformSettingsServiceDependencies {
  workspaceRepository: Pick<WorkspaceRepositoryPort, "findById" | "updateGeneralSettings">;
  retrievalSettingsService: Pick<
    RetrievalSettingsService,
    "getForWorkspace" | "listMetadataFieldSuggestions" | "updateForWorkspace"
  >;
  auditService?: Pick<AuditService, "record">;
  publicChatBaseUrl?: string;
}

export interface PlatformSettingsUpdateContext {
  accountId?: string | null;
}

export class PlatformSettingsService {
  constructor(private readonly dependencies: PlatformSettingsServiceDependencies) {}

  async getForWorkspace(workspaceId: string): Promise<PlatformSettingsResource> {
    const [workspace, retrievalSettings, metadataFieldSuggestions] = await Promise.all([
      this.dependencies.workspaceRepository.findById(workspaceId),
      this.dependencies.retrievalSettingsService.getForWorkspace(workspaceId),
      this.dependencies.retrievalSettingsService.listMetadataFieldSuggestions(workspaceId),
    ]);

    if (!workspace) {
      throw notFound("Workspace not found");
    }

    return {
      assistant: buildAssistantSettingsSection(workspace, retrievalSettings),
      retrieval: this.buildRetrievalSection(retrievalSettings, metadataFieldSuggestions),
      channels: this.buildChannelsSection(workspace),
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

    let currentWorkspace = workspace;
    let currentRetrievalSettings = retrievalSettings;

    if (patch.assistant || patch.channels) {
      currentWorkspace = await this.updateWorkspaceSections(workspaceId, currentWorkspace, patch, context);
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
      assistant: buildAssistantSettingsSection(currentWorkspace, currentRetrievalSettings),
      retrieval: this.buildRetrievalSection(currentRetrievalSettings, metadataFieldSuggestions),
      channels: this.buildChannelsSection(currentWorkspace),
    };
  }

  private async updateWorkspaceSections(
    workspaceId: string,
    workspace: WorkspaceRecord,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext,
  ): Promise<WorkspaceRecord> {
    const channels = patch.channels ?? {};
    const assistant = patch.assistant ?? {};
    const anonymousChatEnabled = channels.anonymousChatEnabled ?? workspace.anonymousChatEnabled;
    const anonymousRateLimit = channels.anonymousRateLimit ?? workspace.anonymousRateLimit;

    let anonymousChatToken = workspace.anonymousChatToken;
    if (channels.rotateAnonymousChatToken) {
      anonymousChatToken = randomBytes(16).toString("base64url");
    } else if (anonymousChatEnabled && !anonymousChatToken) {
      anonymousChatToken = randomBytes(16).toString("base64url");
    }

    let websiteEmbedToken = workspace.websiteEmbedToken;
    if (channels.rotateWebsiteEmbedToken) {
      websiteEmbedToken = randomBytes(16).toString("base64url");
    }

    let normalizedWebsiteEmbed;
    try {
      normalizedWebsiteEmbed = validateWebsiteEmbedSettings({
        websiteEmbedEnabled: channels.websiteEmbedEnabled ?? workspace.websiteEmbedEnabled,
        websiteEmbedToken,
        websiteEmbedAllowedOrigins: channels.websiteEmbedAllowedOrigins ?? workspace.websiteEmbedAllowedOrigins,
        websiteEmbedLauncherLabel: channels.websiteEmbedLauncherLabel ?? workspace.websiteEmbedLauncherLabel,
        websiteEmbedLauncherIcon: channels.websiteEmbedLauncherIcon ?? workspace.websiteEmbedLauncherIcon,
        websiteEmbedLauncherPosition: channels.websiteEmbedLauncherPosition ?? workspace.websiteEmbedLauncherPosition,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw badRequest(error.message);
      }
      throw error;
    }

    if (normalizedWebsiteEmbed.websiteEmbedEnabled && !websiteEmbedToken) {
      websiteEmbedToken = randomBytes(16).toString("base64url");
    }
    if (normalizedWebsiteEmbed.websiteEmbedEnabled && !anonymousChatToken) {
      anonymousChatToken = randomBytes(16).toString("base64url");
    }

    const normalizedBootstrap = validateAssistantBootstrapSettings({
      assistantName: assistant.assistantName ?? workspace.assistantName,
      assistantRole: assistant.assistantRole ?? workspace.assistantRole,
      greetingInstruction: assistant.greetingInstruction ?? workspace.greetingInstruction,
      assistantDefaultLocale:
        assistant.assistantDefaultLocale === undefined
          ? workspace.assistantDefaultLocale
          : assistant.assistantDefaultLocale,
      proactiveGreetingEnabled: assistant.proactiveGreetingEnabled ?? workspace.proactiveGreetingEnabled,
    });

    const updated = await this.dependencies.workspaceRepository.updateGeneralSettings(workspaceId, {
      anonymousChatEnabled,
      anonymousChatToken,
      anonymousRateLimit,
      ...normalizedBootstrap,
      websiteEmbedEnabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
      websiteEmbedToken,
      websiteEmbedAllowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: normalizedWebsiteEmbed.websiteEmbedLauncherLabel,
      websiteEmbedLauncherIcon: normalizedWebsiteEmbed.websiteEmbedLauncherIcon,
      websiteEmbedLauncherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
    });

    await this.recordChannelAuditEvents({
      accountId: context.accountId,
      workspaceId,
      previousWorkspace: workspace,
      anonymousChatEnabled,
      anonymousRateLimit,
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
    previousWorkspace: WorkspaceRecord;
    anonymousChatEnabled: boolean;
    anonymousRateLimit: number;
    rotateAnonymousChatToken: boolean;
    websiteEmbedEnabled: boolean;
    websiteEmbedAllowedOrigins: string[];
    websiteEmbedLauncherPosition: WorkspaceRecord["websiteEmbedLauncherPosition"];
    rotateWebsiteEmbedToken: boolean;
  }): Promise<void> {
    const auditService = this.dependencies.auditService;
    if (!auditService) {
      return;
    }

    if (input.anonymousChatEnabled !== input.previousWorkspace.anonymousChatEnabled) {
      await auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.anonymousChatEnabled ? "anonymous_chat.enabled" : "anonymous_chat.disabled",
        eventStatus: "success",
        metadata: { anonymousRateLimit: input.anonymousRateLimit },
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

    if (input.websiteEmbedEnabled !== input.previousWorkspace.websiteEmbedEnabled) {
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
    const assistant = patch.assistant ?? {};
    const retrieval = patch.retrieval ?? {};
    const next = validateRetrievalSettings({
      ...existing,
      queryRewriteEnabled: retrieval.queryRewriteEnabled ?? existing.queryRewriteEnabled,
      semanticRewriteInstructions: retrieval.semanticRewriteInstructions ?? existing.semanticRewriteInstructions,
      lexicalRewriteInstructions: retrieval.lexicalRewriteInstructions ?? existing.lexicalRewriteInstructions,
      answerSupportPolicy: retrieval.answerSupportPolicy ?? existing.answerSupportPolicy,
      conversationMode: assistant.conversationMode ?? existing.conversationMode,
      suggestedQuestionsEnabled: assistant.suggestedQuestionsEnabled ?? existing.suggestedQuestionsEnabled,
      suggestedQuestionsCount: assistant.suggestedQuestionsCount ?? existing.suggestedQuestionsCount,
      rerankEnabled: retrieval.rerankEnabled ?? existing.rerankEnabled,
      vectorTopK: retrieval.vectorTopK ?? existing.vectorTopK,
      similarityThreshold: retrieval.similarityThreshold ?? existing.similarityThreshold,
      rerankTopK: retrieval.rerankTopK ?? existing.rerankTopK,
      citationDisplayEnabled: retrieval.citationDisplayEnabled ?? existing.citationDisplayEnabled,
      metadataRules: retrieval.metadataRules ?? existing.metadataRules,
      customInstruction: assistant.customInstruction ?? existing.customInstruction,
    });

    return (await this.dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, next)) ?? {
      ...existing,
      ...next,
    };
  }

  private hasRetrievalSettingsPatch(patch: PlatformSettingsPatch): boolean {
    const assistant = patch.assistant;
    return Boolean(
      patch.retrieval ||
      assistant?.conversationMode !== undefined ||
      assistant?.suggestedQuestionsEnabled !== undefined ||
      assistant?.suggestedQuestionsCount !== undefined ||
      assistant?.customInstruction !== undefined,
    );
  }

  private buildRetrievalSection(
    settings: RetrievalSettingsRecord,
    metadataFieldSuggestions: PlatformRetrievalSettingsSection["metadataFieldSuggestions"],
  ): PlatformRetrievalSettingsSection {
    return {
      queryRewriteEnabled: settings.queryRewriteEnabled,
      semanticRewriteInstructions: settings.semanticRewriteInstructions,
      lexicalRewriteInstructions: settings.lexicalRewriteInstructions,
      answerSupportPolicy: settings.answerSupportPolicy,
      rerankEnabled: settings.rerankEnabled,
      vectorTopK: settings.vectorTopK,
      similarityThreshold: settings.similarityThreshold,
      rerankTopK: settings.rerankTopK,
      citationDisplayEnabled: settings.citationDisplayEnabled,
      metadataRules: settings.metadataRules,
      metadataFieldSuggestions,
    };
  }

  private buildChannelsSection(workspace: WorkspaceRecord): PlatformChannelsSettingsSection {
    return {
      anonymousChatEnabled: workspace.anonymousChatEnabled,
      anonymousChatUrl: this.buildAnonymousChatUrl(workspace.anonymousChatToken, workspace.anonymousChatEnabled),
      anonymousRateLimit: workspace.anonymousRateLimit,
      websiteEmbedEnabled: workspace.websiteEmbedEnabled,
      websiteEmbedToken: workspace.websiteEmbedToken,
      websiteEmbedAllowedOrigins: workspace.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: workspace.websiteEmbedLauncherLabel,
      websiteEmbedLauncherIcon: workspace.websiteEmbedLauncherIcon,
      websiteEmbedLauncherPosition: workspace.websiteEmbedLauncherPosition,
      websiteEmbedScriptUrl: this.buildWebsiteEmbedScriptUrl(),
      websiteEmbedSnippet: this.buildWebsiteEmbedSnippet(workspace),
    };
  }

  private buildAnonymousChatUrl(token: string | null, enabled: boolean): string | null {
    const baseUrl = this.dependencies.publicChatBaseUrl;
    if (!baseUrl || !enabled || !token) {
      return null;
    }
    return `${baseUrl}/${token}`;
  }

  private buildWebsiteEmbedScriptUrl(): string | null {
    const baseUrl = this.dependencies.publicChatBaseUrl;
    if (!baseUrl) {
      return null;
    }

    try {
      return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, new URL(baseUrl).origin).toString();
    } catch {
      return null;
    }
  }

  private buildWebsiteEmbedSnippet(workspace: WorkspaceRecord): string | null {
    if (!workspace.websiteEmbedEnabled || !workspace.websiteEmbedToken) {
      return null;
    }

    const scriptUrl = this.buildWebsiteEmbedScriptUrl();
    if (!scriptUrl) {
      return null;
    }

    const originAttribute =
      workspace.websiteEmbedAllowedOrigins.length > 0
        ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(workspace.websiteEmbedAllowedOrigins.join(","))}"`
        : "";
    const displayName = resolveAssistantDisplayName({
      assistantName: workspace.assistantName,
      workspaceName: workspace.name,
    });
    const titleOverride = displayName
      ? ` data-radioso-copy="${escapeHtmlAttribute(JSON.stringify({ embeddedChatTitle: displayName }))}"`
      : "";

    return [
      `<script`,
      `  async`,
      `  src="${escapeHtmlAttribute(scriptUrl)}"`,
      `  data-radioso-token="${escapeHtmlAttribute(workspace.websiteEmbedToken)}"`,
      `  data-radioso-launcher-label="${escapeHtmlAttribute(workspace.websiteEmbedLauncherLabel)}"`,
      `  data-radioso-launcher-icon="${escapeHtmlAttribute(workspace.websiteEmbedLauncherIcon)}"`,
      `  data-radioso-launcher-position="${escapeHtmlAttribute(workspace.websiteEmbedLauncherPosition)}"${originAttribute}${titleOverride}`,
      `></script>`,
    ].join("\n");
  }
}

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
