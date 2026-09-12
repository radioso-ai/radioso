import { z } from "zod";

import { projectRoutineToPortableDocument, routineDefinitionDraftInputSchema, routineFieldPatchSchema, type RoutineDefinition } from "../../routines/public.js";
import type {
  CopilotMcpInvocationReconciliation,
  CopilotMcpProposalRecoveryPort,
  CopilotProposal,
  CopilotRoutineProposalDraft,
  CopilotEntityDescription,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  describeNamedAgent,
  entity,
  normalizeEntityName,
  recordProposalCreated,
  copilotProposalOrigin,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  citedEvidenceSchema,
  citedProposalEvidence,
  proposalEvidenceOutput,
  proposalOutputSchema,
  type CopilotProposalEvidenceDependencies,
  proposalAdapterFor,
  scopedAgentDraftPublicationNote,
  type CopilotProposalToolDependencies,
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
const copilotRoutineEditableElementLimit = 40;

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
  enabled: z.boolean(),
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
// The error names only routineId: routineTitle only ever resolves through describeEntity, which
// runs in the Ray dashboard turn loop and never over the MCP transport, so promising it here would
// mislead an MCP caller who hits this error. routineTitle stays supported in the input schema for
// dashboard use; this is only about what the error text can honestly tell every caller.
const requiredRoutine = (routineId: string | undefined): string => {
  if (!routineId) throw new Error("Name the routine first: pass routineId.");
  return routineId;
};
export interface RoutineDefinitionCopilotToolDependencies {
  readonly agentLookup: CopilotAgentLookupPort;
  readonly routineDefinitionService: CopilotRoutineDefinitionPort;
}

export const createRoutineDefinitionCopilotTools = (deps: RoutineDefinitionCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "routine_definition", shape: "read", verificationCost: () => 0, uiLabel: "Reading routine", contributingModule: "routines", dashboardSubject: { type: "routine" }, requiredPermissions: ["workspace.agents.read"],
    description: "List an agent's routines, or read one routine: its wording as portable Markdown, plus the stable ids of every step, ending, and information field an edit can address.",
    inputSchema: routineDefinitionInputSchema, outputSchema: routineDefinitionOutputSchema,
    createTool: (context) => ({
      name: "routine_definition",
      description: "List an agent's routines, or read one routine: its wording as portable Markdown, plus the stable ids of every step, ending, and information field an edit can address.",
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
      const agentId = parsed.agentId ?? context?.pageContext.agentId;
      return parsed.agentName || parsed.routineTitle
        ? describeNamedRoutine(parsed, context, deps)
        : parsed.routineId
          ? { type: "routine", id: parsed.routineId, ...(agentId ? { agentId } : {}) }
          : entity("agent", agentId);
    },
  },
  {
    // A read rather than a probe: validation is structural, spends no model budget, persists
    // nothing, and is safe to retry. Declaring it a probe would tell a transport not to retry a
    // call that is free and deterministic.
    name: "validate_routine", shape: "read", verificationCost: () => 0, uiLabel: "Validating routine", contributingModule: "routines", dashboardSubject: { type: "routine" }, requiredPermissions: ["workspace.agents.read"],
    description: "Check one routine for structural problems — unreachable steps, dangling references, unknown skills — and report each diagnostic.",
    inputSchema: validateRoutineInputSchema, outputSchema: validateRoutineOutputSchema,
    createTool: (context) => ({
      name: "validate_routine",
      description: "Check one routine for structural problems — unreachable steps, dangling references, unknown skills — and report each diagnostic.",
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
          enabled: routine.enabled,
          ok: validation.ok,
          diagnosticCount: validation.diagnostics.length,
          diagnosticsTruncated: validation.diagnostics.length > copilotRoutineDiagnosticLimit,
          diagnostics: validation.diagnostics.slice(0, copilotRoutineDiagnosticLimit).map((diagnostic) => ({ ...diagnostic })),
        };
      },
    }),
    describeEntity: (input, context) => describeRoutineTarget(input as z.infer<typeof validateRoutineInputSchema>, context, deps),
  },

];

const describeRoutineTarget = (
  input: { agentId?: string; agentName?: string; routineId?: string; routineTitle?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  deps: { readonly agentLookup?: CopilotAgentLookupPort; readonly routineDefinitionService?: Pick<CopilotRoutineDefinitionPort, "list"> },
): CopilotEntityDescription<typeof input> | null | Promise<CopilotEntityDescription<typeof input> | null> => {
  // A named agent still has to resolve when the routine is already addressed by id: the routine
  // lookup is scoped by agent, and leaving agentName unresolved would silently fall back to
  // whichever agent the page happens to be on.
  if (input.routineId && !input.agentName) {
    const agentId = input.agentId ?? context?.pageContext.agentId ?? undefined;
    return { type: "routine", id: input.routineId, ...(agentId ? { agentId } : {}) };
  }
  return deps.agentLookup && deps.routineDefinitionService
    ? describeNamedRoutine(input, context, { agentLookup: deps.agentLookup, routineDefinitionService: deps.routineDefinitionService })
    : entity("agent", input.agentId ?? context?.pageContext.agentId);
};

const routineIdentity = (routine: RoutineDefinition) => ({
  id: routine.id,
  name: routine.name,
  enabled: routine.enabled,
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
/** Caps one editable element array to `copilotRoutineEditableElementLimit`, the same signal `portable.content`'s `omittedReason` gives when its own cap cuts something. */
const cappedEditableElements = <T>(elements: ReadonlyArray<T>): { items: T[]; truncated: boolean } => ({
  items: elements.slice(0, copilotRoutineEditableElementLimit),
  truncated: elements.length > copilotRoutineEditableElementLimit,
});

const projectRoutineEditableElements = (routine: RoutineDefinition) => {
  const steps = cappedEditableElements(routine.steps.map((step) => ({ stableStepId: step.stableStepId, kind: step.kind, instruction: locator(step.instruction) })));
  const endings = cappedEditableElements(routine.terminals.map((terminal) => ({ stableStepId: terminal.stableStepId, kind: terminal.kind, instruction: locator(terminal.instruction ?? null) })));
  const fields = cappedEditableElements((routine.slots ?? []).map((slot) => ({ key: slot.key, type: slot.type, required: slot.required, description: locator(slot.description ?? null) })));
  return {
    steps: steps.items,
    stepsTruncated: steps.truncated,
    endings: endings.items,
    endingsTruncated: endings.truncated,
    fields: fields.items,
    fieldsTruncated: fields.truncated,
  };
};

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
  // A routine list is already one row per routine, so a name only stays ambiguous across
  // different routines — which is the ambiguity an operator can actually resolve.
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
  const routine = routines[0];
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

// The tool transport renders a nested input object as the bare word "object", so the shape of
// `changes` has to live in the description or the model invents one of its own. Shared by both
// descriptor variants below so the two copies cannot drift out of step with the schema.
const routineEditDescription = `Propose an edit to an existing routine's wording, name, trigger, or whether it is enabled. \`changes\` takes at least one of: \`name\` (string); \`enabled\` (boolean, takes the routine in or out of service without touching its wording); \`activation\` ({triggerDescription?, priority?, reentryMode?, coverageCriteria?: {coverage: [...], reasons?: [...]}}); \`steps\` ([{stableStepId, instruction}]); \`terminals\` ([{stableStepId, instruction}], an ending); \`slots\` ([{key, description?, required?}], an information field). Example: {"steps":[{"stableStepId":"ask_order_number","instruction":"Ask for the order number and say why we need it."}]}. Every id comes from the \`editable\` block \`routine_definition\` returns — read the routine first and never invent one. It edits elements that already exist: it cannot add or remove a step or rework branching, so send the operator to the routine editor for those. It drafts a proposal for operator review and changes nothing until the operator applies it. ${scopedAgentDraftPublicationNote}`;

const routineValidationOutput = (draft: CopilotRoutineProposalDraft) => ({
  ok: draft.diagnostics.length === 0,
  diagnostics: draft.diagnostics.slice(0, copilotRoutineDiagnosticLimit).map((diagnostic) => ({ ...diagnostic })),
});

export interface RoutineProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies, CopilotProposalToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly routineDefinitionService?: Pick<CopilotRoutineDefinitionPort, "list">;
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
}

/**
 * Mirrors the payload propose_routine persists: the routine draft plus the drafted rationale used
 * to rebuild the card's summary (see createRoutineCopilotProposalAdapter.draft in
 * proposalAdapters.ts).
 */
const routineDraftProposalPayloadSchema = routineDefinitionDraftInputSchema.extend({ rationale: z.string() });
/** Mirrors the payload propose_routine_edit persists (see .draftEdit in proposalAdapters.ts). */
const routineEditProposalPayloadSchema = z.object({
  kind: z.literal("edit"),
  name: z.string(),
  changes: routineFieldPatchSchema,
  rationale: z.string().optional(),
}).strict();
/**
 * Reconstructs a recovered routine proposal's output from its persisted payload. Shared by both
 * routine proposal tools since each writes `targetType: "routine"` and the reconstruction
 * (targetLabel/summary from name/rationale) is identical; only the payload schema differs.
 *
 * `validation` cannot be faithfully reconstructed: the diagnostics a draft call computes are
 * reported to the caller in the moment but never persisted on the proposal row (see
 * CopilotRoutineProposalDraft — only `payload`, `targetLabel`, and `summary` survive to storage).
 * A recovered response therefore always reports `{ ok: true, diagnostics: [] }` rather than
 * guessing; the routine's real diagnostics remain visible whenever the proposal or routine is next
 * read or validated. This is a known limitation, not a claim that the routine is clean.
 */
const reconcileRoutineProposalPayload = (
  proposal: CopilotProposal,
  schema: { safeParse(value: unknown): { success: true; data: { name: string; rationale?: string } } | { success: false } },
): CopilotMcpInvocationReconciliation<z.infer<typeof routineProposalOutputSchema>> => {
  if (proposal.targetType !== "routine") return { status: "conflict" };
  const payload = schema.safeParse(proposal.payload);
  if (!payload.success) return { status: "conflict" };
  return {
    status: "recovered",
    output: {
      proposalId: proposal.id,
      targetType: "routine" as const,
      targetLabel: payload.data.name,
      summary: payload.data.rationale ?? payload.data.name,
      validation: { ok: true, diagnostics: [] },
      ...proposalEvidenceOutput(proposal.evidence),
    },
  };
};

export const createRoutineProposalCopilotTools = (deps: RoutineProposalCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => {
  const routineAdapter = proposalAdapterFor(deps.proposalAdapters, "routine");
  return [
    {
      name: "propose_routine", shape: "propose", verificationCost: () => 0, uiLabel: "Drafting a routine", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: `Draft a new routine proposal for the operator to review and apply. This does not change configuration. ${scopedAgentDraftPublicationNote}`,
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: routineProposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_routine",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        return reconcileRoutineProposalPayload(recovery.proposal, routineDraftProposalPayloadSchema);
      },
      createTool: (context) => ({
        name: "propose_routine",
      description: `Draft a new routine proposal for the operator to review and apply. This does not change configuration. ${scopedAgentDraftPublicationNote}`,
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: routineProposalOutputSchema,
        invoke: async ({ agentId, intent, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await routineAdapter.draft(context.workspaceId, targetRef, intent);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          // A create names no row of its own to read a version from - the adapter needs the
          // drafted name to check the one thing that actually determines whether Apply would
          // still succeed (see the comment on createRoutineVersionToken).
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef, draft.payload);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "routine" });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            origin: copilotProposalOrigin(context),
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
      name: "propose_routine_edit", shape: "propose", verificationCost: () => 0, uiLabel: "Drafting a routine edit", contributingModule: "routines", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: routineEditDescription,
      inputSchema: routineEditInputSchema, outputSchema: routineProposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_routine_edit",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        return reconcileRoutineProposalPayload(recovery.proposal, routineEditProposalPayloadSchema);
      },
      createTool: (context) => ({
        name: "propose_routine_edit",
        description: routineEditDescription,
        inputSchema: routineEditInputSchema,
        outputSchema: routineProposalOutputSchema,
        invoke: async ({ agentId, routineId, changes, rationale, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: requiredRoutine(routineId) };
          // The guard token is read before the draft: a token read afterwards could describe a
          // routine edited in between, and the edit would then apply to content Ray never saw.
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await routineAdapter.draftEdit(context.workspaceId, targetRef, changes, rationale);
          return proposeRoutineChange(deps, routineAdapter, context, targetRef, draft, versionToken, evidenceIds);
        },
      }),
      describeEntity: (input, context) => describeRoutineTarget(input as z.infer<typeof validateRoutineInputSchema>, context, deps),
    },

  ];
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
    origin: copilotProposalOrigin(context),
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
