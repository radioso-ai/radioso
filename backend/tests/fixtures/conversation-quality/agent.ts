import type { ConversationAgent } from "../../../src/modules/agents/domain.js";
import { projectInternalAgentConfig } from "../../../src/modules/agents/agentConfig.js";
import { conversationQualityDirectives } from "./directives.js";
import { CQ_AGENT_ID } from "./routines.js";

export const CQ_WORKSPACE_ID = "cq-workspace";

/**
 * The single seed agent every case runs against: retrieval enabled over the whole
 * corpus, carrying the three seed directives. Its persona is deliberately plain so that
 * observed tone/precision comes from the directives (and grounding from the corpus),
 * which is what the cases are measuring.
 */
export const conversationQualityAgent: ConversationAgent = {
  id: CQ_AGENT_ID,
  workspaceId: CQ_WORKSPACE_ID,
  name: "Acme Support",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  customInstruction: "You are Acme's support assistant. Answer from the provided documents.",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: true,
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: ["support@acme.example"], webhook: null },
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  chatModelOverride: null,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat",
      launcherPosition: "bottom-right",
      theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  authoredDirectives: conversationQualityDirectives,
};

export const conversationQualityAgentConfig = projectInternalAgentConfig(conversationQualityAgent);
