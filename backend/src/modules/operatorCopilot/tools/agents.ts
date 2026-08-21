import { z } from "zod";

import { serializeAgentConfig, type AgentConfig, type ConversationAgent } from "../../agents/public.js";
import { builtInAnswerDirectiveViews, type BuiltInDirectiveView } from "../../directives/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAuditPort,
  CopilotDirectiveProposalAdapter,
  CopilotProposal,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { boundPayload } from "../payloadCompaction.js";
import {
  describeNamedAgent,
  entity,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentListItem,
  type CopilotAgentLookupPort,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });
const agentConfigurationInputSchema = z.object({
  mode: z.enum(["auto", "list", "detail"]).optional(),
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  directiveId: idSchema.optional(),
}).strict();
const agentConfigurationOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("list"),
    agentCount: z.number().int().nonnegative(),
    agentsTruncated: z.boolean(),
    agents: z.array(unknownRecord),
    agent: z.null(),
  }),
  z.object({
    mode: z.literal("detail"),
    agentCount: z.null(),
    agentsTruncated: z.null(),
    agents: z.array(unknownRecord).max(0),
    agent: unknownRecord,
  }),
]);

const copilotAgentListLimit = 40;
const copilotDirectiveListLimit = 40;
const copilotBuiltInDirectiveListLimit = 20;
const copilotBuiltInDirectiveActionCharLimit = 8_000;
const copilotBuiltInDirectiveTotalActionCharBudget = 20_000;
const copilotDirectiveDetailCollectionLimit = 10;
const copilotDirectiveMetadataCharLimit = 4_000;
const copilotDirectiveDetailCharBudget = 24_000;


export interface CopilotAgentConfigurationPort extends CopilotAgentLookupPort {
  resolve(workspaceId: string, agentId: string): Promise<ConversationAgent>;
}

export interface AgentConfigurationCopilotToolDependencies {
  readonly agentService: CopilotAgentConfigurationPort;
}

export const createAgentConfigurationCopilotTools = (deps: AgentConfigurationCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_configuration", shape: "read", uiLabel: "Reading agent configuration", contributingModule: "agents", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
    inputSchema: agentConfigurationInputSchema, outputSchema: agentConfigurationOutputSchema,
    createTool: (context) => ({
      name: "agent_configuration",
      description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
      inputSchema: agentConfigurationInputSchema,
      outputSchema: agentConfigurationOutputSchema,
      invoke: async ({ mode = "auto", agentId, directiveId }) => {
        if (mode === "list") {
          if (agentId || directiveId) throw new Error("Agent discovery does not accept an agent or directive id");
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const resolvedAgentId = agentId ?? (mode === "detail" || directiveId
          ? requiredPageAgent(context.pageContext.agentId)
          : context.pageContext.agentId);
        if (!resolvedAgentId) {
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const selectedAgent = await deps.agentService.resolve(context.workspaceId, resolvedAgentId);
        return {
          mode: "detail" as const,
          agentCount: null,
          agentsTruncated: null,
          agents: [],
          agent: projectAgentConfiguration(selectedAgent, directiveId),
        };
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as z.infer<typeof agentConfigurationInputSchema>;
      return parsed.mode === "list"
      ? null
        : parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentService)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },

];

const projectAgentSummaries = (
  agents: ReadonlyArray<CopilotAgentListItem>,
) => agents.slice(0, copilotAgentListLimit).map((agent) => ({
  id: agent.id,
  name: agent.name,
  isDefault: agent.isDefault,
  assistantBootstrapActive: agent.assistantBootstrapActive,
}));

const projectAgentConfiguration = (
  agent: ConversationAgent,
  directiveId: string | undefined,
): Record<string, unknown> => {
  const serialized = serializeAgentConfig(agent);
  const { authoredDirectives: portableDirectives, ...portableAgent } = serialized;
  const directives = agent.authoredDirectives ?? [];
  const selectedIndex = directiveId
    ? directives.findIndex((directive) => directive.id === directiveId)
    : -1;
  if (directiveId && selectedIndex < 0) throw new Error("Directive not found");

  const visibleIndexes = Array.from(
    { length: Math.min(directives.length, copilotDirectiveListLimit) },
    (_, index) => index,
  );
  if (selectedIndex >= copilotDirectiveListLimit) {
    visibleIndexes[visibleIndexes.length - 1] = selectedIndex;
  }

  return {
    id: agent.id,
    ...boundPayload(portableAgent as unknown as Record<string, unknown>),
    authoredDirectives: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
      priority: directives[index]!.priority,
      actionChars: directives[index]!.action.length,
    })),
    directiveCount: directives.length,
    directivesTruncated: directives.length > copilotDirectiveListLimit,
    directiveRefs: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
    })),
    builtInDirectiveCount: builtInAnswerDirectiveViews.length,
    builtInsTruncated: builtInAnswerDirectiveViews.length > copilotBuiltInDirectiveListLimit,
    builtIns: projectBuiltInDirectives(builtInAnswerDirectiveViews),
    directive: selectedIndex >= 0
      ? projectDirectiveDetail(directives[selectedIndex]!.id, portableDirectives[selectedIndex]!)
      : null,
  };
};

const projectBuiltInDirectives = (
  directives: ReadonlyArray<BuiltInDirectiveView>,
): ReadonlyArray<Record<string, unknown>> => {
  let remainingActionChars = copilotBuiltInDirectiveTotalActionCharBudget;
  return directives.slice(0, copilotBuiltInDirectiveListLimit).map((directive) => {
    const actionTooLarge = directive.action.length > copilotBuiltInDirectiveActionCharLimit;
    const exceedsTotalBudget = directive.action.length > remainingActionChars;
    const omittedReason = actionTooLarge
      ? "content_too_large"
      : exceedsTotalBudget ? "total_budget" : null;
    if (!omittedReason) remainingActionChars -= directive.action.length;
    const boundedIdentity = boundPayload({
      name: directive.name,
      condition: directive.condition,
      priority: directive.priority,
      description: directive.description,
    });
    return {
      ...boundedIdentity,
      action: omittedReason ? null : directive.action,
      actionChars: directive.action.length,
      omittedReason,
    };
  });
};

const directiveCollectionKeys = [
  "requiredCapabilities",
  "dependsOn",
  "excludes",
  "routes",
  "tags",
] as const satisfies ReadonlyArray<keyof AgentConfig["authoredDirectives"][number]>;

const projectDirectiveDetail = (
  id: string,
  directive: AgentConfig["authoredDirectives"][number],
): Record<string, unknown> => {
  const metadataChars = JSON.stringify(directive.metadata).length;
  const metadataOmitted = metadataChars > copilotDirectiveMetadataCharLimit;
  const truncatedCollections = directiveCollectionKeys.filter(
    (key) => directive[key].length > copilotDirectiveDetailCollectionLimit,
  );
  const boundedCollections = Object.fromEntries(directiveCollectionKeys.map((key) => [
    key,
    directive[key].slice(0, copilotDirectiveDetailCollectionLimit),
  ]));
  const projected = {
    id,
    ...directive,
    ...boundedCollections,
    metadata: metadataOmitted ? null : directive.metadata,
    detailBounds: {
      metadataOmittedReason: metadataOmitted ? "content_too_large" : null,
      truncatedCollections,
    },
  };
  const projectedChars = JSON.stringify(projected).length;
  if (projectedChars <= copilotDirectiveDetailCharBudget) return projected;

  const allPopulatedCollections = directiveCollectionKeys.filter((key) => directive[key].length > 0);
  const withoutCollections = {
    ...projected,
    ...Object.fromEntries(directiveCollectionKeys.map((key) => [key, []])),
    metadata: null,
    detailBounds: {
      metadataOmittedReason: "total_budget",
      truncatedCollections: allPopulatedCollections,
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
  if (JSON.stringify(withoutCollections).length <= copilotDirectiveDetailCharBudget) return withoutCollections;

  return {
    id,
    name: directive.name,
    priority: directive.priority,
    action: null,
    detailBounds: {
      detailOmittedReason: "content_too_large",
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
};


const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(["directive", "agent_setting", "routine"]),
  targetLabel: z.string(),
  summary: z.string(),
});

export interface AgentSettingProposalCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}

export const createAgentSettingProposalCopilotTools = (
  deps: AgentSettingProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const settingAdapter = proposalAdapter(deps.proposalAdapters);
  return [
    {
      name: "propose_agent_setting", shape: "propose", uiLabel: "Drafting a setting change", contributingModule: "agents", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Draft an agent setting change for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_agent_setting",
        description: "Draft an agent setting change for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, settingKey, value, rationale }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), settingKey };
          const validated = await settingAdapter.validatePayload(context.workspaceId, targetRef, { value, ...(rationale ? { rationale } : {}) });
          const versionToken = await settingAdapter.readVersionToken(context.workspaceId, validated.targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "agent_setting",
            targetRef: validated.targetRef,
            payload: validated.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "agent_setting" as const, targetLabel: settingKey, summary: rationale ?? settingKey };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentLookup)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
  ];
};

const proposalAdapter = (
  adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>,
): CopilotAgentSettingProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "agent_setting");
  if (!adapter) throw new Error("No copilot proposal adapter registered for agent_setting");
  return adapter as CopilotAgentSettingProposalAdapter;
};
