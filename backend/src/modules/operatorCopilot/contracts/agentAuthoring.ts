import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";

const httpUrlSchema = z.string().trim().url().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use http or https");

/**
 * What an agent proposal asks for. Every field is one the agent wizard's own creation contract
 * accepts and acts on, so the two entry points into agent creation cannot describe different agents
 * and the card cannot state a change the apply does not make. The chunking strategy is deliberately
 * absent: it is workspace-scoped ingestion configuration that creating an agent does not write, and
 * `propose_ingestion_settings` is the proposal that does.
 */
export const copilotAgentChangeSchema = z.object({
  websiteUrl: httpUrlSchema,
  name: z.string().trim().min(1).max(200),
  customInstruction: z.string().trim().min(1).max(2_000),
  greetingInstruction: z.string().trim().max(200).optional(),
  faviconUrl: httpUrlSchema.optional(),
  assistantDefaultLocale: z.string().trim().max(35).optional(),
  privacyPolicyUrl: httpUrlSchema.optional(),
  contactEmail: z.string().trim().max(320).email().optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

export const copilotAgentPayloadSchema = z.object({
  /** Every proposal card reads its target's label from `name`. */
  name: z.string().trim().min(1).max(200),
  websiteUrl: httpUrlSchema,
  customInstruction: z.string().trim().min(1).max(2_000),
  greetingInstruction: z.string().trim().max(200),
  faviconUrl: httpUrlSchema.optional(),
  assistantDefaultLocale: z.string().trim().max(35).optional(),
  privacyPolicyUrl: httpUrlSchema.optional(),
  contactEmail: z.string().trim().max(320).optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

export const copilotAgentTargetRefSchema = z.object({ websiteUrl: httpUrlSchema }).strict();

export type CopilotAgentChange = z.infer<typeof copilotAgentChangeSchema>;
export type CopilotAgentPayload = z.infer<typeof copilotAgentPayloadSchema>;

/** The wizard's creation contract, narrowed to the fields a proposal carries. */
export interface CopilotAgentCreationPort {
  createFromWizard(input: {
    workspaceId: string;
    /** Null when the workspace's account cannot be resolved; the wizard treats it as unattributed. */
    accountId: string | null;
    config: {
      websiteUrl: string;
      name: string;
      customInstruction: string;
      greetingInstruction: string;
      faviconUrl?: string | null;
      assistantDefaultLocale?: string | null;
      privacyPolicyUrl?: string | null;
      contactEmail?: string | null;
    };
  }): Promise<{
    agentId: string;
    crawlJobId: string | null;
    /** Set when the agent was created but a step after it failed. The agent still exists. */
    incomplete?: { step: "configuration" | "ingestion"; reason: string };
  }>;
}

export interface CopilotAgentAnalysisPage {
  readonly url: string;
  readonly title: string | null;
}

/**
 * The wizard's analysis, minus the screenshot. A base64 page image is the largest field the wizard
 * produces and the one thing in it a language model cannot read, so it is dropped at the port rather
 * than trimmed at the tool - nothing downstream of Ray should be able to reach it by accident.
 */
export interface CopilotAgentWebsiteAnalysis {
  readonly sourceUrl: string;
  readonly suggestedName: string;
  readonly suggestedCustomInstruction: string;
  readonly suggestedGreetingMessage: string;
  readonly suggestedChunkingStrategy: { readonly strategy: "fixed_window" | "structured_semantic"; readonly reasoning: string };
  readonly faviconUrl: string | null;
  readonly pagesAnalyzed: ReadonlyArray<CopilotAgentAnalysisPage>;
  readonly suggestedLocale: string | null;
  readonly suggestedPrivacyPolicyUrl: string | null;
  readonly suggestedContactEmail: string | null;
}

export interface CopilotWebsiteAnalysisProbeInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  readonly url: string;
}

export interface CopilotWebsiteAnalysisProbePort {
  analyze(input: CopilotWebsiteAnalysisProbeInput): Promise<CopilotAgentWebsiteAnalysis>;
}

/** The owner module's analysis, narrowed to what a probe needs. */
export interface CopilotAgentWizardAnalysisPort {
  analyzeWebsite(input: {
    url: string;
    workspaceId: string;
    accountId: string;
  }): Promise<CopilotAgentWebsiteAnalysis>;
}

export interface WebsiteAnalysisProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  agentWizardAnalysis: CopilotAgentWizardAnalysisPort;
}
