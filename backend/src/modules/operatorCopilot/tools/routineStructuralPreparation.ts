import { z } from "zod";

import {
  canonicalRoutineAuthoringDraft,
  projectRoutineForReview,
  applyOperatorMcpRoutineTransform,
  RoutineTransformError,
  routineDefinitionDraftInputSchema,
  routineSlotSchema,
  routineStepSchema,
  routineTerminalSchema,
  routineTransitionSchema,
  type RoutineDefinition,
  type RoutineDefinitionService,
  type OperatorMcpRoutineTransformReferenceGuard,
} from "../../routines/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import type { CopilotMcpProposalRecoveryPort } from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { canonicalReviewedOperationDigest } from "../reviewedOperation.js";
import { routineValidationRefusal } from "../routineValidationRefusal.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { copilotProposalOrigin } from "./shared.js";

/** The one message every blocking structural-validation failure states, whatever the caller is trying to do to the routine. */
const ROUTINE_NOT_SERVABLE_MESSAGE = "The routine cannot be served. Disable it to park it, or use validate_routine to correct the reported diagnostics.";

const structuralOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_enabled"), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("reorder_steps"), stableStepIds: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal("insert_step"), step: routineStepSchema }).strict(),
  z.object({ kind: z.literal("replace_step"), previous: routineStepSchema, next: routineStepSchema }).strict(),
  z.object({ kind: z.literal("remove_step"), stableStepId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("insert_slot"), slot: routineSlotSchema }).strict(),
  z.object({ kind: z.literal("replace_slot"), previous: routineSlotSchema, next: routineSlotSchema }).strict(),
  z.object({ kind: z.literal("remove_slot"), stableSlotId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("insert_terminal"), terminal: routineTerminalSchema }).strict(),
  z.object({ kind: z.literal("replace_terminal"), previous: routineTerminalSchema, next: routineTerminalSchema }).strict(),
  z.object({ kind: z.literal("remove_terminal"), stableStepId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("insert_transition"), transition: routineTransitionSchema }).strict(),
  z.object({ kind: z.literal("replace_transition"), previous: routineTransitionSchema, next: routineTransitionSchema }).strict(),
  z.object({ kind: z.literal("remove_transition"), transition: routineTransitionSchema }).strict(),
]);

/** The fields each `kind` carries; everything else on that call is a mistake worth naming. */
const fieldsPerKind = {
  edit: ["routineId", "operations"],
  create: ["draft"],
  delete: ["routineId"],
} as const satisfies Record<string, ReadonlyArray<"routineId" | "operations" | "draft">>;
const conditionalFields = ["routineId", "operations", "draft"] as const;
const conditionalFieldTypes = { routineId: "string", operations: "array", draft: "object" } as const satisfies Record<typeof conditionalFields[number], z.ZodParsedType>;

/**
 * One tagged object rather than a union of three untagged object shapes. A `z.union` serializes to
 * a root-level `anyOf` with no `properties`: an MCP client that builds a signature from
 * `properties` advertises a tool that takes no arguments, strict-mode function calling refuses a
 * root-level `anyOf` outright, and the text-routed gateway renders the whole tool as `(unknown)`.
 * `kind` states which of the three calls this is; the refinement below keeps the per-kind
 * requirements the branches used to carry.
 */
const inputSchema = z.object({
  kind: z.enum(["edit", "create", "delete"]).describe("edit applies explicit graph commands to an existing routine, create drafts a new one, delete retires one."),
  agentId: z.string().uuid(),
  // The per-kind requirements belong in the advertised schema, not only in the refinement: a
  // caller reading three bare optionals still has to guess which of them its kind needs.
  routineId: z.string().uuid().optional().describe("The routine being changed. Required for kind edit and kind delete; omit for create."),
  operations: z.array(structuralOperationSchema).min(1).max(100).optional().describe("The explicit graph commands to apply. Required for kind edit; omit for create and delete."),
  draft: routineDefinitionDraftInputSchema.optional().describe("The whole routine to draft. Required for kind create; omit for edit and delete."),
}).strict().superRefine((input, ctx) => {
  const carried: ReadonlyArray<string> = fieldsPerKind[input.kind];
  for (const field of conditionalFields) {
    const present = input[field] !== undefined;
    if (carried.includes(field) === present) continue;
    // The same issue codes a plain required/strict object would raise, so a caller reading the
    // rejected path reads one vocabulary rather than a per-field custom message.
    if (present) ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: [field], path: [], message: `\`${field}\` does not belong to kind "${input.kind}".` });
    else ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: conditionalFieldTypes[field], received: "undefined", path: [field], message: `\`${field}\` is required when kind is "${input.kind}".` });
  }
}).transform((input) => (
  // The refinement above aborts the chain before this runs, so each kind's fields are present.
  input.kind === "create"
    ? { kind: "create" as const, agentId: input.agentId, draft: input.draft as NonNullable<typeof input.draft> }
    : input.kind === "delete"
      ? { kind: "delete" as const, agentId: input.agentId, routineId: input.routineId as string }
      : { kind: "edit" as const, agentId: input.agentId, routineId: input.routineId as string, operations: input.operations as NonNullable<typeof input.operations> }
));

const outputSchema = z.object({
  proposalId: z.string(),
  reviewDigest: z.string(),
  // MCP serializes tool values as JSON. Return the persisted expiry in that
  // representation rather than relying on a Date being stringified later.
  expiresAt: z.string().datetime(),
  diagnostics: z.array(z.object({ code: z.string(), location: z.string(), message: z.string() })).max(40),
  review: z.object({
    before: z.record(z.unknown()),
    after: z.record(z.unknown()),
    truncated: z.boolean(),
    detailAvailable: z.boolean(),
    beforeConnections: z.array(z.object({ fromStep: z.string(), toRef: z.string(), guardKind: z.string(), ordinal: z.number() })).max(40),
    afterConnections: z.array(z.object({ fromStep: z.string(), toRef: z.string(), guardKind: z.string(), ordinal: z.number() })).max(40),
    connectionsTruncated: z.boolean(),
    operations: z.array(z.unknown()).max(40),
    operationsTruncated: z.boolean(),
  }).strict(),
}).strict();

const reviewLimit = 40;
const reviewSections = ["slots", "steps", "transitions", "terminals"] as const;
const connectionsForReview = (transitions: ReadonlyArray<{ fromStep: string; toRef: string; guardKind: string; ordinal: number }>) =>
  transitions.slice(0, reviewLimit).map(({ fromStep, toRef, guardKind, ordinal }) => ({ fromStep, toRef, guardKind, ordinal }));
type RoutineReviewInput = RoutineDefinition | Parameters<typeof projectRoutineForReview>[0];

const isStoredRoutine = (routine: RoutineReviewInput): routine is RoutineDefinition => "agentId" in routine;

const boundedRoutineReview = (routine: RoutineReviewInput) => {
  // The stored continuation is a canonical authoring draft, not the keyed comparison view:
  // it retains stable IDs and every persisted authoring control. The keyed projection below is
  // solely the bounded reviewer summary.
  const full = isStoredRoutine(routine)
    ? canonicalRoutineAuthoringDraft(routine)
    : routineDefinitionDraftInputSchema.parse(routine);
  const comparison = projectRoutineForReview(full);
  let truncated = false;
  const summary = { ...comparison } as Record<string, unknown>;
  for (const section of reviewSections) {
    const entries = Object.entries((comparison[section] ?? {}) as Record<string, unknown>);
    if (entries.length > reviewLimit) truncated = true;
    summary[section] = Object.fromEntries(entries.slice(0, reviewLimit));
  }
  return { summary, full, truncated };
};
const storedReviewSnapshot = (input: {
  readonly diagnostics: ReadonlyArray<{ code: string; location: string; message: string }>;
  readonly review: z.infer<typeof outputSchema.shape.review>;
  readonly fullReview: { readonly before: unknown; readonly after: unknown };
}) => ({ diagnostics: input.diagnostics, review: input.review, fullReview: input.fullReview });
const reviewOutput = (input: {
  readonly proposalId: string;
  readonly reviewDigest: string;
  readonly expiresAt: Date;
  readonly snapshot: { readonly diagnostics: unknown; readonly review: unknown };
}) => outputSchema.parse({
  proposalId: input.proposalId,
  reviewDigest: input.reviewDigest,
  expiresAt: input.expiresAt.toISOString(),
  diagnostics: input.snapshot.diagnostics,
  review: input.snapshot.review,
});

export interface RoutineStructuralPreparationDependencies {
  readonly routines: Pick<RoutineDefinitionService, "get" | "validateForDraftMutation"> & { readonly findCreateConflict?: RoutineDefinitionService["findCreateConflict"] };
  readonly scopedReferences: {
    assertNoScopedReferences(input: { readonly workspaceId: string; readonly agentId: string; readonly routineId: string; readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] }): Promise<void>;
  };
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly auditService: { record(input: { accountId: string; workspaceId: string; eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, unknown> }): Promise<void> };
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
}

/** Prepares a structurally explicit routine draft; applying it remains the reviewed-operation path. */
export const createRoutineStructuralPreparationTool = (
  deps: RoutineStructuralPreparationDependencies,
): CopilotToolDescriptor => ({
  name: "prepare_routine_structure",
  shape: "propose",
  verificationCost: () => 0,
  uiLabel: "Preparing routine structure",
  description: "Prepare a routine change for review; this does not change the routine. Set kind to \"edit\" to apply explicit graph commands to an existing routine, \"create\" to draft a new one, or \"delete\" to retire one.",
  contributingModule: "routines",
  dashboardSubject: { type: "proposal" },
  requiredPermissions: ["workspace.agents.manage"],
  inputSchema,
  outputSchema,
  reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
    if (!invocation.operationId) return { status: "conflict" };
    const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: "prepare_routine_structure", inputDigest: invocation.inputDigest, staleBefore, now });
    if (recovered.status !== "recovered" || recovered.proposal.targetType !== "routine" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
    const snapshot = z.object({ diagnostics: outputSchema.shape.diagnostics, review: outputSchema.shape.review }).safeParse(recovered.proposal.reviewSnapshot);
    if (!snapshot.success) return { status: "conflict" };
    return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } };
  },
  createTool: (context) => ({
    name: "prepare_routine_structure",
    description: "Prepare a routine change for review; this does not change the routine. Set kind to \"edit\" to apply explicit graph commands to an existing routine, \"create\" to draft a new one, or \"delete\" to retire one.",
    inputSchema,
    outputSchema,
    invoke: async (rawInput) => {
      const input = inputSchema.parse(rawInput);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      if (input.kind === "create") {
        await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
        const validation = await deps.routines.validateForDraftMutation(context.workspaceId, input.agentId, input.draft);
        if (!validation.ok) throw routineValidationRefusal(ROUTINE_NOT_SERVABLE_MESSAGE, null, validation.diagnostics);
        const blocking = await deps.routines.findCreateConflict?.(context.workspaceId, input.agentId, input.draft.name);
        const targetRef = { agentId: input.agentId, routineId: null };
        const payload = { kind: "create" as const, draft: input.draft };
        const versionToken = blocking ? `blocked:${blocking.id}:${blocking.updatedAt.toISOString()}` : "open";
        const after = boundedRoutineReview(input.draft);
        const reviewSnapshot = storedReviewSnapshot({ diagnostics: validation.diagnostics.slice(0, reviewLimit), review: { before: {}, after: after.summary, truncated: after.truncated, detailAvailable: after.truncated, beforeConnections: [], afterConnections: connectionsForReview(input.draft.transitions ?? []), connectionsTruncated: (input.draft.transitions?.length ?? 0) > reviewLimit, operations: [{ kind: "create" }], operationsTruncated: false }, fullReview: { before: {}, after: after.full } });
        const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
        const now = deps.now?.() ?? new Date();
        const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
        const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "routine", targetRef, payload, versionToken, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
        await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "routine", operatorUserId: context.operatorUserId, surface: context.surface } });
        return reviewOutput({ proposalId: proposal.id, reviewDigest, expiresAt, snapshot: reviewSnapshot });
      }
      const current = await deps.routines.get(context.workspaceId, input.agentId, input.routineId);
      if (input.kind === "delete") {
        await deps.scopedReferences.assertNoScopedReferences({ workspaceId: context.workspaceId, agentId: input.agentId, routineId: input.routineId, removedNodeIds: [...current.steps, ...current.terminals].map((node) => node.stableStepId), removedSlotIds: (current.slots ?? []).map((slot) => slot.stableSlotId) });
        const targetRef = { agentId: input.agentId, routineId: input.routineId };
        const payload = { kind: "delete" as const };
        const versionToken = current.updatedAt.toISOString();
        const before = boundedRoutineReview(current);
        const reviewSnapshot = storedReviewSnapshot({ diagnostics: [], review: { before: before.summary, after: {}, truncated: before.truncated, detailAvailable: before.truncated, beforeConnections: connectionsForReview(current.transitions ?? []), afterConnections: [], connectionsTruncated: (current.transitions?.length ?? 0) > reviewLimit, operations: [{ kind: "delete" }], operationsTruncated: false }, fullReview: { before: before.full, after: {} } });
        const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
        const now = deps.now?.() ?? new Date();
        const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
        const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "routine", targetRef, payload, versionToken, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
        await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "routine", operatorUserId: context.operatorUserId, surface: context.surface } });
        return reviewOutput({ proposalId: proposal.id, reviewDigest, expiresAt, snapshot: reviewSnapshot });
      }
      const removedReferences: { current: { readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] } | null } = { current: null };
      const referenceGuard: OperatorMcpRoutineTransformReferenceGuard = {
        // The transform is intentionally synchronous and pure. Capture its exact affected
        // identifiers, then ask the owner for async cross-resource validation before a review
        // artifact is persisted.
        assertNoScopedReferences: (references) => { removedReferences.current = references; },
      };
      let draft;
      try {
        draft = applyOperatorMcpRoutineTransform(current, { operations: input.operations }, referenceGuard);
      } catch (error) {
        if (error instanceof RoutineTransformError) throw badRequest("The routine changed or the requested graph replacement is no longer exact. Read the routine again and prepare a new edit.");
        throw error;
      }
      const references = removedReferences.current;
      if (references) {
        await deps.scopedReferences.assertNoScopedReferences({
          workspaceId: context.workspaceId,
          agentId: input.agentId,
          routineId: input.routineId,
          removedNodeIds: references.removedNodeIds,
          removedSlotIds: references.removedSlotIds,
        });
      }
      const validation = await deps.routines.validateForDraftMutation(context.workspaceId, input.agentId, draft);
      if (!validation.ok) throw routineValidationRefusal(ROUTINE_NOT_SERVABLE_MESSAGE, input.routineId, validation.diagnostics);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const targetRef = { agentId: input.agentId, routineId: input.routineId };
      const payload = { kind: "structural", draft, operations: input.operations };
      const versionToken = current.updatedAt.toISOString();
      const beforeConnections = connectionsForReview(current.transitions ?? []);
      const afterConnections = connectionsForReview(draft.transitions ?? []);
      const before = boundedRoutineReview(current);
      const after = boundedRoutineReview(draft);
      const reviewSnapshot = storedReviewSnapshot({ diagnostics: validation.diagnostics.slice(0, 40), review: { before: before.summary, after: after.summary, truncated: before.truncated || after.truncated, detailAvailable: before.truncated || after.truncated, beforeConnections, afterConnections, connectionsTruncated: (current.transitions?.length ?? 0) > reviewLimit || (draft.transitions?.length ?? 0) > reviewLimit, operations: input.operations.slice(0, reviewLimit), operationsTruncated: input.operations.length > reviewLimit }, fullReview: { before: before.full, after: after.full } });
      const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
      const now = deps.now?.() ?? new Date();
      const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
      const proposal = await deps.proposalRepository.createProposal({
        workspaceId: context.workspaceId,
        operatorUserId: context.operatorUserId,
        origin: copilotProposalOrigin(context),
        targetType: "routine",
        targetRef,
        payload,
        versionToken,
        evidence: null,
        reviewDigest,
        reviewSnapshot,
        expiresAt,
      });
      await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "routine", operatorUserId: context.operatorUserId, surface: context.surface } });
      return reviewOutput({ proposalId: proposal.id, reviewDigest, expiresAt, snapshot: reviewSnapshot });
    },
  }),
});
