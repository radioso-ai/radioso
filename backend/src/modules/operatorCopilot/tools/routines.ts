import { z } from "zod";

import { projectRoutineToPortableDocument, routineFieldPatchSchema, type RoutineDefinition } from "../../routines/public.js";
import type {
  CopilotAuditPort,
  CopilotAgentSettingProposalAdapter,
  CopilotRoutineProposalDraft,
  CopilotEntityDescription,
  CopilotProposal,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
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
const copilotRoutineDiagnosticLimit = 40;

const routineDiagnosticSchema = z.object({ code: z.string(), location: z.string(), message: z.string() });
const validateRoutineInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  routineId: idSchema.optional(),
  routineTitle: entityNameSchema.optional(),
}).strict();
const validateRoutineOutputSchema = z.object({
  routineId: z.string(),
  name: z.string(),
  status: z.string(),
  ok: z.boolean(),
  diagnosticCount: z.number().int().nonnegative(),
  diagnosticsTruncated: z.boolean(),
  diagnostics: z.array(routineDiagnosticSchema).max(copilotRoutineDiagnosticLimit),
});

export interface CopilotRoutineValidationResult {
  readonly ok: boolean;
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly location: string; readonly message: string }>;
}

export interface CopilotRoutineDefinitionPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<RoutineDefinition>>;
  get(workspaceId: string, agentId: string, routineId: string): Promise<RoutineDefinition>;
  validate(workspaceId: string, agentId: string, target: { id: string }): Promise<CopilotRoutineValidationResult>;
}

// Every routine write addresses one routine. Name resolution rewrites `routineTitle` into
// `routineId` before invocation, so an id still missing here means the operator never named one.
const requiredRoutine = (routineId: string | undefined): string => {
  if (!routineId) throw new Error("Name the routine first: pass routineId, or routineTitle to resolve one by name.");
  return routineId;
};
export interface RoutineDefinitionCopilotToolDependencies {
  readonly agentLookup: CopilotAgentLookupPort;
  readonly routineDefinitionService: CopilotRoutineDefinitionPort;
}

export const createRoutineDefinitionCopilotTools = (deps: RoutineDefinitionCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "routine_definition", shape: "read", uiLabel: "Reading routine", contributingModule: "routines", dashboardSubject: { type: "routine" }, requiredPermissions: ["workspace.agents.read"],
    description: "List an agent's routines, or read one routine: its wording as portable Markdown, plus the stable ids of every step, ending, and information field an edit can address.",
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
        ? describeNamedRoutine(parsed, context, deps, liveFirst)
        : parsed.routineId
          ? { type: "routine", id: parsed.routineId, ...(parsed.agentId ?? context?.pageContext.agentId ? { agentId: parsed.agentId ?? context?.pageContext.agentId! } : {}) }
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
  {
    // A read rather than a probe: validation is structural, spends no model budget, persists
    // nothing, and is safe to retry. Declaring it a probe would tell a transport not to retry a
    // call that is free and deterministic.
    name: "validate_routine", shape: "read", uiLabel: "Validating routine", contributingModule: "routines", dashboardSubject: { type: "routine" }, requiredPermissions: ["workspace.agents.read"],
    description: "Check one routine for structural problems — unreachable steps, dangling references, unknown skills — and report each diagnostic.",
    inputSchema: validateRoutineInputSchema, outputSchema: validateRoutineOutputSchema,
    createTool: (context) => ({
      name: "validate_routine",
      description: "Check one routine for structural problems and report each diagnostic.",
      inputSchema: validateRoutineInputSchema,
      outputSchema: validateRoutineOutputSchema,
      invoke: async ({ agentId, routineId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        const resolvedRoutineId = requiredRoutine(routineId);
        const routine = await deps.routineDefinitionService.get(context.workspaceId, resolvedAgentId, resolvedRoutineId);
        const validation = await deps.routineDefinitionService.validate(context.workspaceId, resolvedAgentId, { id: resolvedRoutineId });
        return {
          routineId: routine.id,
          name: routine.name,
          status: routine.status,
          ok: validation.ok,
          diagnosticCount: validation.diagnostics.length,
          diagnosticsTruncated: validation.diagnostics.length > copilotRoutineDiagnosticLimit,
          diagnostics: validation.diagnostics.slice(0, copilotRoutineDiagnosticLimit).map((diagnostic) => ({ ...diagnostic })),
        };
      },
    }),
    // Validation answers "is this ready to go live", which is a question about the draft.
    describeEntity: (input, context) => describeRoutineTarget(input as z.infer<typeof validateRoutineInputSchema>, context, deps, draftFirst),
  },

];

const describeRoutineTarget = (
  input: { agentId?: string; agentName?: string; routineId?: string; routineTitle?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  deps: { readonly agentLookup?: CopilotAgentLookupPort; readonly routineDefinitionService?: Pick<CopilotRoutineDefinitionPort, "list"> },
  preference: RoutineVersionPreference = liveFirst,
): CopilotEntityDescription<typeof input> | null | Promise<CopilotEntityDescription<typeof input> | null> => {
  // A named agent still has to resolve when the routine is already addressed by id: the routine
  // lookup is scoped by agent, and leaving agentName unresolved would silently fall back to
  // whichever agent the page happens to be on.
  if (input.routineId && !input.agentName) {
    const agentId = input.agentId ?? context?.pageContext.agentId ?? undefined;
    return { type: "routine", id: input.routineId, ...(agentId ? { agentId } : {}) };
  }
  return deps.agentLookup && deps.routineDefinitionService
    ? describeNamedRoutine(input, context, { agentLookup: deps.agentLookup, routineDefinitionService: deps.routineDefinitionService }, preference)
    : entity("agent", input.agentId ?? context?.pageContext.agentId);
};

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

const copilotRoutineLocatorCharLimit = 160;

const locator = (text: string | null): string | null =>
  text === null ? null : text.length > copilotRoutineLocatorCharLimit ? `${text.slice(0, copilotRoutineLocatorCharLimit)}…` : text;

/**
 * The elements an edit can address, by the stable id it has to name.
 *
 * The portable document is prose: it carries what a routine says, not the ids proposing a change
 * addresses. Without this a reader can describe a step perfectly and still have no way to name it,
 * which leaves guessing an id as the only move. Each entry carries enough text to tell the elements
 * apart; the wording itself is in `portable.content`.
 */
const projectRoutineEditableElements = (routine: RoutineDefinition) => ({
  steps: routine.steps.map((step) => ({ stableStepId: step.stableStepId, kind: step.kind, instruction: locator(step.instruction) })),
  endings: routine.terminals.map((terminal) => ({ stableStepId: terminal.stableStepId, kind: terminal.kind, instruction: locator(terminal.instruction ?? null) })),
  fields: (routine.slots ?? []).map((slot) => ({ key: slot.key, type: slot.type, required: slot.required, description: locator(slot.description ?? null) })),
});

const projectRoutineDetail = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  const editable = projectRoutineEditableElements(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), editable, portable: projected };
  }
  const contentChars = projected.envelope.content.length;
  const contentTooLarge = contentChars > copilotRoutineContentCharLimit;
  return {
    ...routineIdentity(routine),
    editable,
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      content: contentTooLarge ? null : projected.envelope.content,
      contentChars,
      omittedReason: contentTooLarge ? "content_too_large" : null,
    },
  };
};


/**
 * Which version of a named routine a tool means.
 *
 * A lineage keeps every version it has ever had: publishing leaves the previous one `superseded`,
 * revising adds a `draft` beside the published row, and all of them carry the same name. Which one
 * an operator means depends on what they asked for — "why did it do that" is about what is running,
 * "reword step 3" and "publish it" are about the draft — so each tool states its own order and a
 * name collapses to one routine per lineage. Names stay ambiguous across *different* lineages,
 * which is the ambiguity an operator can actually resolve.
 */
export type RoutineVersionPreference = ReadonlyArray<RoutineDefinition["status"]>;
const liveFirst: RoutineVersionPreference = ["published", "draft", "archived"];
const draftFirst: RoutineVersionPreference = ["draft", "published", "archived"];
const archivedFirst: RoutineVersionPreference = ["archived", "published", "draft"];

const currentRoutineVersions = (
  routines: ReadonlyArray<RoutineDefinition>,
  preference: RoutineVersionPreference,
): RoutineDefinition[] => {
  const byLineage = new Map<string, RoutineDefinition>();
  for (const routine of routines) {
    const rank = preference.indexOf(routine.status);
    if (rank < 0) continue;
    const held = byLineage.get(routine.lineageId);
    if (!held || rank < preference.indexOf(held.status)) byLineage.set(routine.lineageId, routine);
  }
  return [...byLineage.values()];
};

const describeNamedRoutine = async (
  input: { agentId?: string; agentName?: string; routineId?: string; routineTitle?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  deps: { readonly agentLookup: CopilotAgentLookupPort; readonly routineDefinitionService: Pick<CopilotRoutineDefinitionPort, "list"> },
  preference: RoutineVersionPreference = liveFirst,
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
    const reference = { type: "routine" as const, id: resolvedInput.routineId, ...(agentId ? { agentId } : {}) };
    // When the agent came from a name, the resolved id has to travel back into the tool input too,
    // or the invocation falls back to the page's agent and looks the routine up under that one.
    return agentDescription && "kind" in agentDescription
      ? { kind: "resolved", entity: reference, input: resolvedInput }
      : reference;
  }
  if (!resolvedInput.routineTitle) {
    return entity("agent", agentId);
  }
  if (!context) return { kind: "not_found" };

  const agents = agentId
    ? [{ id: agentId }]
    : (await deps.agentLookup.listExisting(context.workspaceId)).map((agent) => ({ id: agent.id }));
  const routines = (await Promise.all(agents.map(async (agent) =>
    currentRoutineVersions(await deps.routineDefinitionService.list(context.workspaceId, agent.id), preference).map((routine) => ({
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


const routineProposalOutputSchema = proposalOutputSchema.extend({
  /** What the proposed routine still fails on, so Ray can fix it rather than shipping a broken card. */
  validation: z.object({ ok: z.boolean(), diagnostics: z.array(routineDiagnosticSchema).max(copilotRoutineDiagnosticLimit) }),
});
const routineProposalIdentitySchema = {
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  routineId: idSchema.optional(),
  routineTitle: entityNameSchema.optional(),
  rationale: z.string().trim().min(1).max(500).optional(),
  evidenceIds: citedEvidenceSchema,
};
const routineEditInputSchema = z.object({ ...routineProposalIdentitySchema, changes: routineFieldPatchSchema }).strict();
const routineLifecycleInputSchema = z.object({ ...routineProposalIdentitySchema, action: z.enum(["publish", "archive", "restore"]) }).strict();

const routineValidationOutput = (draft: CopilotRoutineProposalDraft) => ({
  ok: draft.diagnostics.length === 0,
  diagnostics: draft.diagnostics.slice(0, copilotRoutineDiagnosticLimit).map((diagnostic) => ({ ...diagnostic })),
});

export interface RoutineProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly routineDefinitionService?: Pick<CopilotRoutineDefinitionPort, "list">;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}
export const createRoutineProposalCopilotTools = (deps: RoutineProposalCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => {
  const routineAdapter = proposalAdapter(deps.proposalAdapters);
  return [
    {
      name: "propose_routine", shape: "propose", uiLabel: "Drafting a routine", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Draft a new routine proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: routineProposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine",
        description: "Draft a new routine proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: routineProposalOutputSchema,
        invoke: async ({ agentId, intent, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await routineAdapter.draft(context.workspaceId, targetRef, intent);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "routine" });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
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
          return { proposalId: proposal.id, targetType: "routine" as const, targetLabel: draft.targetLabel, summary: draft.summary, validation: routineValidationOutput(draft), ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentLookup)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
    {
      name: "propose_routine_edit", shape: "propose", uiLabel: "Drafting a routine edit", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      // The tool transport renders a nested input object as the bare word "object", so the shape
      // of `changes` has to live in the description or the model invents one of its own.
      description: "Propose an edit to an existing routine's wording, name, or trigger. `changes` takes at least one of: `name` (string); `activation` ({triggerDescription?, priority?, reentryMode?}); `steps` ([{stableStepId, instruction}]); `terminals` ([{stableStepId, instruction}], an ending); `slots` ([{key, description?, required?}], an information field). Example: {\"steps\":[{\"stableStepId\":\"ask_order_number\",\"instruction\":\"Ask for the order number and say why we need it.\"}]}. Every id comes from the `editable` block `routine_definition` returns — read the routine first and never invent one. It edits elements that already exist: it cannot add or remove a step or rework branching, so send the operator to the routine editor for those. Applying an edit to a published routine revises it into a draft; it does not change what is serving until the draft is published.",
      inputSchema: routineEditInputSchema, outputSchema: routineProposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine_edit",
        description: "Propose an edit to an existing routine's wording, name, or trigger for operator review. It does not change configuration.",
        inputSchema: routineEditInputSchema,
        outputSchema: routineProposalOutputSchema,
        invoke: async ({ agentId, routineId, changes, rationale, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: requiredRoutine(routineId) };
          // The guard token is read before the draft: a token read afterwards could describe a
          // routine revised in between, and the edit would then apply to content Ray never saw.
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await routineAdapter.draftEdit(context.workspaceId, targetRef, changes, rationale);
          return proposeRoutineChange(deps, routineAdapter, context, targetRef, draft, versionToken, evidenceIds);
        },
      }),
      // Edits go to the draft: a published routine is revised into one before it can be edited.
      describeEntity: (input, context) => describeRoutineTarget(input as z.infer<typeof validateRoutineInputSchema>, context, deps, draftFirst),
    },
    {
      name: "propose_routine_lifecycle", shape: "propose", uiLabel: "Drafting a routine lifecycle change", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Propose taking a routine live, out of service, or back into service: publish a draft, archive a published routine, or restore an archived one. This is the only tool that changes what an agent is actually running, so it is proposed separately from editing a routine's content.",
      inputSchema: routineLifecycleInputSchema, outputSchema: routineProposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine_lifecycle",
        description: "Propose publishing, archiving, or restoring a routine for operator review. It does not change configuration.",
        inputSchema: routineLifecycleInputSchema,
        outputSchema: routineProposalOutputSchema,
        invoke: async ({ agentId, routineId, action, rationale, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: requiredRoutine(routineId) };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await routineAdapter.draftLifecycle(context.workspaceId, targetRef, action, rationale);
          return proposeRoutineChange(deps, routineAdapter, context, targetRef, draft, versionToken, evidenceIds);
        },
      }),
      // Each move names a different version: publish the draft, archive what is running, restore
      // what was retired.
      describeEntity: (input, context) => {
        const parsed = input as z.infer<typeof routineLifecycleInputSchema>;
        return describeRoutineTarget(parsed, context, deps, lifecyclePreference[parsed.action]);
      },
    },

  ];
};

const lifecyclePreference: Record<"publish" | "archive" | "restore", RoutineVersionPreference> = {
  publish: draftFirst,
  archive: liveFirst,
  restore: archivedFirst,
};

/** The shared tail of every routine proposal: cite, persist, audit, and report the same shape. */
const proposeRoutineChange = async (
  deps: RoutineProposalCopilotToolDependencies,
  adapter: CopilotRoutineProposalAdapter,
  context: Parameters<CopilotToolDescriptor["createTool"]>[0],
  targetRef: { agentId: string; routineId: string },
  draft: CopilotRoutineProposalDraft,
  versionToken: string,
  evidenceIds: ReadonlyArray<string> | undefined,
) => {
  await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
  const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "routine" });
  await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
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
  return {
    proposalId: proposal.id,
    targetType: "routine" as const,
    targetLabel: draft.targetLabel,
    summary: draft.summary,
    validation: routineValidationOutput(draft),
    ...proposalEvidenceOutput(evidence),
  };
};
const proposalAdapter = (adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>): CopilotRoutineProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "routine");
  if (!adapter) throw new Error("No copilot proposal adapter registered for routine");
  return adapter as CopilotRoutineProposalAdapter;
};
