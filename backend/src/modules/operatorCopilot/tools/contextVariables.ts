import { z } from "zod";

import {
  CONTEXT_VARIABLE_SOURCES,
  CONTEXT_VARIABLE_VALUE_TYPES,
  contextVariableOptionInputSchema,
  contextVariableOptionSchema,
  type ContextVariableOption,
} from "../../context-variables/public.js";
import type {
  CopilotMcpProposalRecoveryPort,
  CopilotToolDescriptor,
} from "../contracts.js";
import { boundPayload, truncationRecordSchema } from "../payloadCompaction.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  citedEvidenceSchema,
  citedProposalEvidence,
  describeNamedAgent,
  entity,
  proposalEvidenceOutput,
  proposalOutputSchema,
  recordProposalCreated,
  copilotProposalOrigin,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  type CopilotProposalEvidenceDependencies,
  proposalAdapterFor,
  scopedAgentDraftPublicationNote,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);

const readerInputSchema = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() }).strict();
const readerOutputSchema = z.object({
  variables: z.array(z.record(z.string(), z.unknown())),
  enablements: z.array(z.record(z.string(), z.unknown())),
  truncation: truncationRecordSchema,
});

const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;

const optionFields = contextVariableOptionInputSchema.shape;
const optionInputSchema = contextVariableOptionInputSchema.extend({
  key: optionFields.key.describe("Identifier the value stores: a letter, then letters, digits or underscores. Never changes."),
  label: optionFields.label.describe("Name operators see."),
  description: optionFields.description.describe("When this option applies, in the operator's language."),
  archived: optionFields.archived.describe("Archive an option instead of removing it."),
});

/** The definition fields a proposal or a reviewed preparation restates; every one optional. */
export const contextVariableDefinitionInputShape = {
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
  valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES).optional()
    .describe("string (Text), enum (Choice: one of its options), json, boolean (Yes/no), number, or date (an ISO calendar date, no time). Only enum takes options, and only enum can be classified."),
  options: z.array(optionInputSchema).nullable().optional()
    .describe("Enum only: the full option list, every existing key included. Omit to keep the stored list."),
  trustTier: z.enum(contextVariableTrustTiers).optional(),
  sensitivity: z.enum(contextVariableSensitivities).optional(),
  defaultSurfacing: z.enum(contextVariableSurfacings).optional(),
};

/** One agent's use of a variable, as a proposal or a reviewed preparation states it. */
export const contextVariableEnablementInputSchema = z.object({
  source: z.enum(CONTEXT_VARIABLE_SOURCES)
    .describe("pushed: the host's API sets the value. resolver: a skill fetches it. classified: the AI picks one of a Choice (enum) attribute's options from the conversation after each reply; never a Private (sensitive) or proof (signed) attribute, at most 8 per agent. It never replaces a value the API or a teammate set for this visitor or conversation (conversation, session, customer or whatsapp_contact scope); an agent-wide or workspace-wide value is a default until the AI picks one. Use surfacing on_reference for classified."),
  resolverSkillId: idSchema.nullable().optional(),
  maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
  resolverTimeoutMs: z.number().int().positive().nullable().optional(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean().optional(),
}).strict();

const proposalInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  variableId: idSchema.optional(),
  ...contextVariableDefinitionInputShape,
  enablement: contextVariableEnablementInputSchema.optional(),
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
  readonly options: readonly ContextVariableOption[] | null;
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
  options: variable.options,
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
  const description = "List a workspace's context variable definitions and the resolved agent's enablement of each one — source (classified: the AI fills it from the conversation), resolver skill, and surfacing. A Choice attribute's options are listed in full, every key a proposal must restate. Never reads a variable's per-visitor runtime value; read a Test Chat turn's attribute values with test_chat_turn_trace.";
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
          // A proposal restates a Choice attribute's options whole, so they are read whole: the
          // definition schema bounds them at `maxOptions`, above the generic array cap.
          return boundPayload(
            { variables: variables.map(projectDefinition), enablements: enablements.map(projectEnablement) },
            undefined,
            new Set(variables.map((_, index) => `$.variables[${index}].options`)),
          );
        },
      }),
      describeEntity: (input, context) => describeContextVariableAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
  ];
};

export interface ContextVariableProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies, CopilotProposalToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
}

/** Mirrors the payload propose_context_variable persists (see createContextVariableCopilotProposalAdapter / contextVariableStoredPayloadSchema in proposalAdapters.ts). */
const contextVariableProposalPayloadSchema = z.object({
  name: z.string(),
  definition: z.object({
    name: z.string(),
    description: z.string().nullable(),
    valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES),
    options: z.array(contextVariableOptionSchema.strict()).nullable().optional(),
    trustTier: z.enum(contextVariableTrustTiers),
    sensitivity: z.enum(contextVariableSensitivities),
    defaultSurfacing: z.enum(contextVariableSurfacings),
  }).strict().nullable(),
  enablement: z.object({
    source: z.enum(CONTEXT_VARIABLE_SOURCES),
    resolverSkillId: z.string().uuid().nullable(),
    maxAgeSeconds: z.number().int().nonnegative().nullable(),
    resolverTimeoutMs: z.number().int().positive().nullable(),
    surfacing: z.enum(contextVariableSurfacings),
    enabled: z.boolean(),
  }).strict().nullable(),
  rationale: z.string().optional(),
}).strict();

export const createContextVariableProposalCopilotTools = (
  deps: ContextVariableProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "context_variable");
  const description = `Propose creating or updating a context variable's definition, an agent's enablement of it, or both, for the operator to review and apply. This does not change configuration. Values are supplied from what was already read, not invented. ${scopedAgentDraftPublicationNote}`;
  return [
    {
      name: "propose_context_variable", shape: "propose", verificationCost: () => 0, uiLabel: "Drafting a context variable", contributingModule: "contextVariables", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description,
      inputSchema: proposalInputSchema,
      outputSchema: proposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_context_variable",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        if (recovery.proposal.targetType !== "context_variable") return { status: "conflict" };
        const payload = contextVariableProposalPayloadSchema.safeParse(recovery.proposal.payload);
        if (!payload.success) return { status: "conflict" };
        return {
          status: "recovered",
          output: {
            proposalId: recovery.proposal.id,
            targetType: "context_variable" as const,
            targetLabel: payload.data.name,
            summary: payload.data.rationale ?? payload.data.name,
            ...proposalEvidenceOutput(recovery.proposal.evidence),
          },
        };
      },
      createTool: (context) => ({
        name: "propose_context_variable",
        description,
        inputSchema: proposalInputSchema,
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, variableId, name, description: variableDescription, valueType, options, trustTier, sensitivity, defaultSurfacing, enablement, rationale, evidenceIds }) => {
          const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
          const targetRef = { agentId: resolvedAgentId, variableId: variableId ?? null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const validated = await adapter.validatePayload(context.workspaceId, targetRef, {
            name, description: variableDescription, valueType, options, trustTier, sensitivity, defaultSurfacing, enablement, rationale,
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
            origin: copilotProposalOrigin(context),
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
