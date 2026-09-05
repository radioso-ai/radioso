import { z } from "zod";

import {
  copilotAgentChangeSchema,
  copilotAgentPayloadSchema,
  type CopilotAgentPayload,
  type CopilotAgentWebsiteAnalysis,
  type CopilotWebsiteAnalysisProbePort,
} from "../contracts/agentAuthoring.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  boundedSummary,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const MANAGE_AGENTS = ["workspace.agents.manage"] as const;

/** How many analyzed pages the probe lists. The analysis reads dozens; a reader needs a sample. */
const MAX_PAGES = 20;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

const httpUrlOutputSchema = z.string().max(MAX_URL_CHARS);

const analyzeInputSchema = z.object({
  url: z.string().trim().url().max(MAX_URL_CHARS),
}).strict();

const omissionSchema = z.object({
  field: z.literal("analysis.pagesAnalyzed"),
  reason: z.literal("array_length"),
  omittedCount: z.number().int().positive(),
}).strict();

const analyzeOutputSchema = z.object({
  analysis: z.object({
    sourceUrl: httpUrlOutputSchema,
    suggestedName: z.string().max(200),
    suggestedCustomInstruction: z.string().max(MAX_INSTRUCTION_CHARS),
    suggestedGreetingMessage: z.string().max(400),
    suggestedChunkingStrategy: z.object({
      strategy: z.enum(["fixed_window", "structured_semantic"]),
      reasoning: z.string().max(1_000),
    }).strict(),
    faviconUrl: httpUrlOutputSchema.nullable(),
    pagesAnalyzed: z.array(z.object({
      url: httpUrlOutputSchema,
      title: z.string().max(300).nullable(),
    }).strict()).max(MAX_PAGES),
    suggestedLocale: z.string().max(35).nullable(),
    suggestedPrivacyPolicyUrl: httpUrlOutputSchema.nullable(),
    suggestedContactEmail: z.string().max(320).nullable(),
  }).strict(),
  omissions: z.array(omissionSchema).max(1),
}).strict();

type AnalyzeInput = z.infer<typeof analyzeInputSchema>;
type AnalyzeOutput = z.infer<typeof analyzeOutputSchema>;

const ANALYZE_NAME = "analyze_website";
const ANALYZE_DESCRIPTION = "Read a public website and return a suggested agent configuration: name, instruction, greeting, locale, contact details, and a chunking strategy with the reasoning behind it. This fetches the site over the network and runs a model over what it finds, so it costs real time and budget and is rate-limited. Nothing is created or stored. Follow it with propose_agent to turn a suggestion into a reviewable proposal. The suggested chunking strategy is workspace-wide ingestion configuration rather than part of an agent, so applying it is a separate propose_ingestion_settings card that would re-chunk every source in the workspace.";

export interface WebsiteAnalysisProbeCopilotToolDependencies {
  readonly websiteAnalysisProbe: CopilotWebsiteAnalysisProbePort;
}

/**
 * Every projected string is clamped rather than validated. The analysis is model-produced, and a
 * single over-long suggestion refusing the whole probe would cost the operator the reading of the
 * site over a field they can edit.
 */
const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const clampNullable = (value: string | null, max: number): string | null =>
  value === null ? null : clamp(value, max);

const projectAnalysis = (analysis: CopilotAgentWebsiteAnalysis): AnalyzeOutput => {
  const omissions: AnalyzeOutput["omissions"] = analysis.pagesAnalyzed.length > MAX_PAGES
    ? [{ field: "analysis.pagesAnalyzed" as const, reason: "array_length" as const, omittedCount: analysis.pagesAnalyzed.length - MAX_PAGES }]
    : [];
  return analyzeOutputSchema.parse({
    analysis: {
      sourceUrl: clamp(analysis.sourceUrl, MAX_URL_CHARS),
      suggestedName: clamp(analysis.suggestedName, 200),
      suggestedCustomInstruction: clamp(analysis.suggestedCustomInstruction, MAX_INSTRUCTION_CHARS),
      suggestedGreetingMessage: clamp(analysis.suggestedGreetingMessage, 400),
      suggestedChunkingStrategy: {
        strategy: analysis.suggestedChunkingStrategy.strategy,
        reasoning: clamp(analysis.suggestedChunkingStrategy.reasoning, 1_000),
      },
      faviconUrl: clampNullable(analysis.faviconUrl, MAX_URL_CHARS),
      pagesAnalyzed: analysis.pagesAnalyzed.slice(0, MAX_PAGES).map((page) => ({
        url: clamp(page.url, MAX_URL_CHARS),
        title: clampNullable(page.title, 300),
      })),
      suggestedLocale: clampNullable(analysis.suggestedLocale, 35),
      suggestedPrivacyPolicyUrl: clampNullable(analysis.suggestedPrivacyPolicyUrl, MAX_URL_CHARS),
      suggestedContactEmail: clampNullable(analysis.suggestedContactEmail, 320),
    },
    omissions,
  });
};

export const createWebsiteAnalysisProbeCopilotTools = (
  deps: WebsiteAnalysisProbeCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<AnalyzeInput, AnalyzeOutput>> => {
  const shared: Pick<CopilotToolDescriptor<AnalyzeInput, AnalyzeOutput>, "name" | "description" | "inputSchema" | "outputSchema"> = {
    name: ANALYZE_NAME,
    description: ANALYZE_DESCRIPTION,
    inputSchema: analyzeInputSchema,
    outputSchema: analyzeOutputSchema,
  };
  return [{
    ...shared,
    shape: "probe",
    // One completion over the crawled pages. The crawl is the wall-clock cost; the model call is
    // the budget one, and it is a single pass rather than a turn per page.
    verificationCost: () => 1,
    uiLabel: "Analyzing a website",
    contributingModule: "agentWizard",
    dashboardSubject: { type: "agent" },
    requiredPermissions: ["workspace.agents.manage"],
    createTool: (context) => ({
      ...shared,
      invoke: async (input) => {
        await requireCurrentCopilotPermissions(context, [...MANAGE_AGENTS]);
        const analysis = await deps.websiteAnalysisProbe.analyze({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
          url: input.url,
        });
        return projectAnalysis(analysis);
      },
    }),
  }];
};

const PROPOSE_NAME = "propose_agent";
const PROPOSE_DESCRIPTION = "Propose creating a new agent from a website, for the operator to review and create. Carries the agent's name, instruction, greeting, default locale, contact email, and privacy policy link. Drafting costs nothing; applying creates the agent and queues its website for ingestion, so say what the agent is for and why the configuration fits the site. Run analyze_website first when the operator has not already described the agent they want. To change an agent that already exists, use propose_agent_setting.";

export type AgentProposalCopilotToolDependencies = CopilotProposalToolDependencies;

const summarize = (payload: CopilotAgentPayload): string => {
  const sentences = [`Create the agent "${payload.name}", grounded in ${payload.websiteUrl}.`];
  if (payload.assistantDefaultLocale) sentences.push(`Default locale ${payload.assistantDefaultLocale}.`);
  if (payload.rationale) sentences.push(payload.rationale);
  return sentences.join(" ");
};

export const createAgentProposalCopilotTools = (
  deps: AgentProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "agent");
  const shared = {
    name: PROPOSE_NAME,
    description: PROPOSE_DESCRIPTION,
    inputSchema: copilotAgentChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    // Drafting settles fields Ray already holds; the site was read by analyze_website, which paid
    // for it. Applying creates the agent and queues a crawl, and neither is synchronous model work.
    verificationCost: () => 0,
    uiLabel: "Drafting an agent",
    contributingModule: "agentWizard",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_AGENTS] as unknown as CopilotToolDescriptor["requiredPermissions"],
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotAgentChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_AGENTS]);
        const validated = await adapter.validatePayload(context.workspaceId, { websiteUrl: change.websiteUrl }, change);
        const payload = validated.payload as CopilotAgentPayload;
        await requireCurrentCopilotPermissions(context, [...MANAGE_AGENTS]);
        const summary = boundedSummary(summarize(payload));
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          conversationId: requiredCopilotConversation(context),
          targetType: "agent",
          targetRef: validated.targetRef,
          payload: copilotAgentPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // No config override installs an agent that does not exist yet, so no replay can measure
          // one. A proposal that cannot be measured says so by carrying nothing.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: "agent" as const,
          targetLabel: payload.name,
          summary,
        };
      },
    }),
  }];
};
