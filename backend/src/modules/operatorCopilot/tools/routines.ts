import { z } from "zod";

import { projectRoutineToPortableDocument, type RoutineDefinition } from "../../routines/public.js";
import type {
  CopilotAuditPort,
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotEntityDescription,
  CopilotProposal,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import {
  describeNamedAgent,
  entity,
  normalizeEntityName,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  citedEvidenceSchema,
  citedProposalEvidence,
  proposalEvidenceOutput,
  proposalOutputSchema,
  type CopilotProposalEvidenceDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const routineDefinitionInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  routineId: idSchema.optional(),
  routineTitle: entityNameSchema.optional(),
});
const routineDefinitionOutputSchema = z.object({
  routineCount: z.number().int().nonnegative(),
  routinesTruncated: z.boolean(),
  routine: z.record(z.unknown()).nullable(),
  routines: z.array(z.record(z.unknown())),
});
const copilotRoutineListLimit = 40;
const copilotRoutineContentCharLimit = 20_000;

export interface CopilotRoutineDefinitionPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<RoutineDefinition>>;
  get(workspaceId: string, agentId: string, routineId: string): Promise<RoutineDefinition>;
}
export interface RoutineDefinitionCopilotToolDependencies {
  readonly agentLookup: CopilotAgentLookupPort;
  readonly routineDefinitionService: CopilotRoutineDefinitionPort;
}

export const createRoutineDefinitionCopilotTools = (deps: RoutineDefinitionCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "routine_definition", shape: "read", uiLabel: "Reading routine", contributingModule: "routines", dashboardSubject: { type: "routine" }, requiredPermissions: ["workspace.agents.read"],
    description: "List an agent's routines or read one routine in portable Markdown form.",
    inputSchema: routineDefinitionInputSchema, outputSchema: routineDefinitionOutputSchema,
    createTool: (context) => ({
      name: "routine_definition",
      description: "List an agent's routines or read one routine in portable Markdown form.",
      inputSchema: routineDefinitionInputSchema,
      outputSchema: routineDefinitionOutputSchema,
      invoke: async ({ agentId, routineId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        if (routineId) {
          const routine = await deps.routineDefinitionService.get(context.workspaceId, resolvedAgentId, routineId);
          return {
            routineCount: 1,
            routinesTruncated: false,
            routine: projectRoutineDetail(routine),
            routines: [],
          };
        }
        const definitions = await deps.routineDefinitionService.list(context.workspaceId, resolvedAgentId);
        return {
          routineCount: definitions.length,
          routinesTruncated: definitions.length > copilotRoutineListLimit,
          routine: null,
          routines: definitions.slice(0, copilotRoutineListLimit).map(projectRoutineSummary),
        };
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as z.infer<typeof routineDefinitionInputSchema>;
      return parsed.agentName || parsed.routineTitle
        ? describeNamedRoutine(parsed, context, deps)
        : parsed.routineId
          ? { type: "routine", id: parsed.routineId, ...(parsed.agentId ?? context?.pageContext.agentId ? { agentId: parsed.agentId ?? context?.pageContext.agentId! } : {}) }
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },

];

const routineIdentity = (routine: RoutineDefinition) => ({
  id: routine.id,
  name: routine.name,
  status: routine.status,
});

const projectRoutineSummary = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      contentChars: projected.envelope.content.length,
    },
  };
};

const projectRoutineDetail = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  const contentChars = projected.envelope.content.length;
  const contentTooLarge = contentChars > copilotRoutineContentCharLimit;
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      content: contentTooLarge ? null : projected.envelope.content,
      contentChars,
      omittedReason: contentTooLarge ? "content_too_large" : null,
    },
  };
};


const describeNamedRoutine = async (
  input: { agentId?: string; agentName?: string; routineId?: string; routineTitle?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  deps: { readonly agentLookup: CopilotAgentLookupPort; readonly routineDefinitionService: Pick<CopilotRoutineDefinitionPort, "list"> },
): Promise<CopilotEntityDescription<typeof input> | null> => {
  const agentDescription = await describeNamedAgent(input, context, deps.agentLookup);
  if (agentDescription && "kind" in agentDescription && agentDescription.kind !== "resolved") {
    return agentDescription;
  }
  const resolvedInput = agentDescription && "kind" in agentDescription
    ? agentDescription.input
    : input;
  const agentId = resolvedInput.agentId ?? context?.pageContext.agentId ?? undefined;

  if (resolvedInput.routineId) {
    return { type: "routine", id: resolvedInput.routineId, ...(agentId ? { agentId } : {}) };
  }
  if (!resolvedInput.routineTitle) {
    return entity("agent", agentId);
  }
  if (!context) return { kind: "not_found" };

  const agents = agentId
    ? [{ id: agentId }]
    : (await deps.agentLookup.listExisting(context.workspaceId)).map((agent) => ({ id: agent.id }));
  const routines = (await Promise.all(agents.map(async (agent) =>
    (await deps.routineDefinitionService.list(context.workspaceId, agent.id)).map((routine) => ({
      agentId: agent.id,
      id: routine.id,
      label: routine.name,
    })),
  ))).flat().filter((routine) => normalizeEntityName(routine.label) === normalizeEntityName(resolvedInput.routineTitle!));
  if (routines.length !== 1) {
    return routines.length === 0
      ? { kind: "not_found" }
      : { kind: "ambiguous", candidates: routines.map((routine) => ({ type: "routine", ...routine })) };
  }
  const routine = routines[0]!;
  return {
    kind: "resolved",
    entity: { type: "routine", ...routine },
    input: { ...resolvedInput, agentId: routine.agentId, routineId: routine.id, routineTitle: undefined },
  };
};


export interface RoutineProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}
export const createRoutineProposalCopilotTools = (deps: RoutineProposalCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => {
  const routineAdapter = proposalAdapter(deps.proposalAdapters);
  return [
    {
      name: "propose_routine", shape: "propose", uiLabel: "Drafting a routine", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Draft a new routine proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine",
        description: "Draft a new routine proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, intent, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: null };
          const draft = await routineAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "routine" });
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "routine",
            targetRef,
            payload: draft.payload,
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "routine" as const, targetLabel: draft.targetLabel, summary: draft.summary, ...proposalEvidenceOutput(evidence) };
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
const proposalAdapter = (adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter>): CopilotRoutineProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "routine");
  if (!adapter) throw new Error("No copilot proposal adapter registered for routine");
  return adapter as CopilotRoutineProposalAdapter;
};
