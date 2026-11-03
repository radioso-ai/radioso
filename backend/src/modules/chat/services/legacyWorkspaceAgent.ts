import type { WorkspaceRecord } from "../../../db/repositories/workspaceRepository.js";
import {
  DEFAULT_CONTACT_REQUEST_DELIVERY,
  defaultAgentBrandingSettings,
  defaultAgentVoiceSettings,
  unpublishedAgentPublicIdentity,
  type AgentRecord,
} from "../../agents/public.js";
import { defaultWebsiteEmbedSettings } from "../../settings/contracts/websiteEmbed.js";

/** The agent a turn answers as when no agent service is wired and no workspace row can be read. */
export const legacyAgentWithoutWorkspace = (workspaceId: string, now: Date): AgentRecord => ({
  id: workspaceId,
  workspaceId,
  name: "",
  customInstruction: "",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: DEFAULT_CONTACT_REQUEST_DELIVERY,
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
  theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
  branding: defaultAgentBrandingSettings(),
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  voice: defaultAgentVoiceSettings(),
  mechanicsReplies: {},
  chatModelOverride: null,
  surfaceSettings: {
    authenticatedChat: {
      enabled: true,
    },
    anonymousChat: {
      enabled: false,
      token: null,
    },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat with us",
      launcherPosition: "bottom-right",
      // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
      theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
      copy: {},
      expertOverrides: {},
      voiceCallsOffered: false,
    },
    extensions: {},
  },
  ...unpublishedAgentPublicIdentity(),
  createdAt: now,
  updatedAt: now,

});

/** The agent a turn answers as when no agent service is wired: the workspace row's own identity. */
export const legacyAgentForWorkspace = (workspaceId: string, workspace: WorkspaceRecord): AgentRecord => ({
  id: workspace.defaultAgentId ?? workspace.id,
  workspaceId,
  name: workspace.assistantName,
  customInstruction: "",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: DEFAULT_CONTACT_REQUEST_DELIVERY,
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
  theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
  branding: defaultAgentBrandingSettings(),
  greetingInstruction: workspace.greetingInstruction,
  assistantDefaultLocale: workspace.assistantDefaultLocale,
  proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
  voice: defaultAgentVoiceSettings(),
  mechanicsReplies: {},
  chatModelOverride: null,
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
      // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
      theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
      copy: {},
      expertOverrides: {},
      voiceCallsOffered: false,
    },
    extensions: {},
  },
  ...unpublishedAgentPublicIdentity(),
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt,

});
