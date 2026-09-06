import { z } from "zod";

import type {
  CopilotToolDescriptor,
} from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  citedEvidenceSchema,
  citedProposalEvidence,
  describeNamedAgent,
  entity,
  proposalEvidenceOutput,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  type CopilotProposalEvidenceDependencies,
  proposalAdapterFor,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);

const readerInputSchema = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() }).strict();
const readerOutputSchema = z.object({ variables: z.array(z.record(z.unknown())), enablements: z.array(z.record(z.unknown())) });

const contextVariableValueTypes = ["string", "json"] as const;
const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;
const contextVariableSources = ["pushed", "browser", "resolver"] as const;

const proposalInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  variableId: idSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
  valueType: z.enum(contextVariableValueTypes).optional(),
  trustTier: z.enum(contextVariableTrustTiers).optional(),
  sensitivity: z.enum(contextVariableSensitivities).optional(),
  defaultSurfacing: z.enum(contextVariableSurfacings).optional(),
  enablement: z.object({
    source: z.enum(contextVariableSources),
    resolverSkillId: idSchema.nullable().optional(),
    maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
    resolverTimeoutMs: z.number().int().positive().nullable().optional(),
    surfacing: z.enum(contextVariableSurfacings),
    enabled: z.boolean().optional(),
  }).strict().optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  evidenceIds: citedEvidenceSchema,
}).strict();

export interface CopilotContextVariablesAgentPort {
  get(workspaceId: string, agentId: string): Promise<unknown>;
  listExisting?: CopilotAgentLookupPort["listExisting"];
}

export interface CopilotContextVariableDefinitionRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly valueType: string;
  readonly trustTier: string;
  readonly sensitivity: string;
  readonly defaultSurfacing: string;
}

export interface CopilotAgentContextVariableEnablementRecord {
  readonly id: string;
  readonly variableId: string;
  readonly source: string;
  readonly resolverSkillId: string | null;
  readonly maxAgeSeconds: number | null;
  readonly resolverTimeoutMs: number | null;
  readonly surfacing: string;
  readonly enabled: boolean;
  readonly variable?: { readonly name: string };
}

export interface CopilotContextVariablesPort {
  listByWorkspace(workspaceId: string): Promise<ReadonlyArray<CopilotContextVariableDefinitionRecord>>;
  listByAgent(workspaceId: string, agentId: string): Promise<ReadonlyArray<CopilotAgentContextVariableEnablementRecord>>;
}

export interface ContextVariablesCopilotToolDependencies {
  readonly agentService: CopilotContextVariablesAgentPort;
  readonly contextVariables: CopilotContextVariablesPort;
}

const projectDefinition = (variable: CopilotContextVariableDefinitionRecord) => ({
  id: variable.id,
  name: variable.name,
  description: variable.description,
  valueType: variable.valueType,
  trustTier: variable.trustTier,
  sensitivity: variable.sensitivity,
  defaultSurfacing: variable.defaultSurfacing,
});

const projectEnablement = (enablement: CopilotAgentContextVariableEnablementRecord) => ({
  id: enablement.id,
  variableId: enablement.variableId,
  variableName: enablement.variable?.name ?? null,
  source: enablement.source,
  resolverSkillId: enablement.resolverSkillId,
  maxAgeSeconds: enablement.maxAgeSeconds,
  resolverTimeoutMs: enablement.resolverTimeoutMs,
  surfacing: enablement.surfacing,
  enabled: enablement.enabled,
});

const describeContextVariableAgent = (
  deps: Pick<ContextVariablesCopilotToolDependencies, "agentService">,
  input: { agentId?: string; agentName?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
) => {
  const agentLookup = deps.agentService.listExisting ? { listExisting: deps.agentService.listExisting } : undefined;
  return input.agentName
    ? describeNamedAgent(input, context, agentLookup)
    : entity("agent", input.agentId ?? context?.pageContext.agentId);
};
export const createContextVariablesCopilotTools = (
  deps: ContextVariablesCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const description = "List a workspace's context variable definitions and the resolved agent's enablement of each one — source, resolver skill, and surfacing. Never reads a variable's per-visitor runtime value.";
  return [
    {
      name: "context_variables", shape: "read", verificationCost: () => 0, uiLabel: "Reading context variables", contributingModule: "contextVariables", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
      description,
      inputSchema: readerInputSchema, outputSchema: readerOutputSchema,
      createTool: (context) => ({
        name: "context_variables", description, inputSchema: readerInputSchema, outputSchema: readerOutputSchema,
        invoke: async ({ agentId }) => {
          const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
          await deps.agentService.get(context.workspaceId, resolvedAgentId);
          const [variables, enablements] = await Promise.all([
            deps.contextVariables.listByWorkspace(context.workspaceId),
            deps.contextVariables.listByAgent(context.workspaceId, resolvedAgentId),
          ]);
          return boundPayload({
            variables: variables.map(projectDefinition),
            enablements: enablements.map(projectEnablement),
          });
        },
      }),
      describeEntity: (input, context) => describeContextVariableAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
  ];
};

export interface ContextVariableProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies, CopilotProposalToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
}

export const createContextVariableProposalCopilotTools = (
  deps: ContextVariableProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "context_variable");
  const description = "Propose creating or updating a context variable's definition, an agent's enablement of it, or both, for the operator to review and apply. This does not change configuration. Values are supplied from what was already read, not invented.";
  return [
    {
      name: "propose_context_variable", shape: "propose", verificationCost: () => 0, uiLabel: "Drafting a context variable", contributingModule: "contextVariables", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description,
      inputSchema: proposalInputSchema,
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_context_variable",
        description,
        inputSchema: proposalInputSchema,
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, variableId, name, description: variableDescription, valueType, trustTier, sensitivity, defaultSurfacing, enablement, rationale, evidenceIds }) => {
          const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
          const targetRef = { agentId: resolvedAgentId, variableId: variableId ?? null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const validated = await adapter.validatePayload(context.workspaceId, targetRef, {
            name, description: variableDescription, valueType, trustTier, sensitivity, defaultSurfacing, enablement, rationale,
          });
          const validatedPayload = validated.payload as { name: string; rationale?: string };
          // validatePayload is the version-token source (see CopilotContextVariableProposalAdapter's
          // doc comment): no follow-up readVersionToken call here.
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, resolvedAgentId, evidenceIds, { targetType: "context_variable" });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "context_variable",
            targetRef: validated.targetRef,
            payload: validated.payload,
            versionToken: validated.versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "context_variable" as const, targetLabel: validatedPayload.name, summary: validatedPayload.rationale ?? validatedPayload.name, ...proposalEvidenceOutput(evidence) };
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
