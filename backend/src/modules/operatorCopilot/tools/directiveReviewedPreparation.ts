import { z } from "zod";

import { authoredDirectiveConditionSchema, directiveAuthorProposalInputSchema, projectDirectiveAuthorProposalInput, type AuthoredDirective, type AuthoredDirectiveInput } from "../../agents/public.js";
import type { AuthoredDirectiveService, DirectiveAuthorService } from "../../agents/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { persistReviewedPreparation, recoverReviewedPreparation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";

const NAME = "prepare_directive";
const DESCRIPTION = "Prepare a directive create, edit, enablement change, or removal for digest-bound review. The coach and advisory coherence check run while preparing; execution writes this reviewed payload. Removing a directive is permanent, so consider disabling it instead. A prepared create survives unrelated agent changes; reviewed changes to the same directive become stale after one executes.";
const inputSchema = z.object({
  kind: z.enum(["create", "edit", "set_enabled", "remove"]), agentId: z.string().uuid(),
  directiveId: z.string().uuid().optional(),
  ...directiveAuthorProposalInputSchema.shape,
  enabled: z.boolean().optional(), rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((input, ctx) => {
  const directiveFields = ["intent", "name", "condition", "action", "priority", "excludes"] as const;
  const needsId = input.kind !== "create";
  if ((input.directiveId !== undefined) !== needsId) {
    if (input.directiveId === undefined) ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["directiveId"], message: "`directiveId` is required for this kind." });
    else ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: ["directiveId"], path: [], message: "`directiveId` does not belong to kind \"create\"." });
  }
  for (const field of directiveFields) if (input.kind !== "create" && input.kind !== "edit" && input[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: [field], path: [], message: `\`${field}\` does not belong to kind "${input.kind}".` });
  if (input.kind === "set_enabled" ? input.enabled === undefined : input.enabled !== undefined) {
    if (input.enabled === undefined) ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: "boolean", received: "undefined", path: ["enabled"], message: "`enabled` is required for kind \"set_enabled\"." });
    else ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: ["enabled"], path: [], message: "`enabled` only belongs to kind \"set_enabled\"." });
  }
}).transform((input) => input as typeof input & { directiveId: string | undefined });

const directiveView = z.object({ name: z.string().max(200), condition: authoredDirectiveConditionSchema, action: z.string().max(4_000), priority: z.number().int().min(0).max(100).nullable(), excludes: z.array(z.string().max(200)).max(100), tags: z.array(z.string().max(200)).max(100), surfaces: z.array(z.string().max(100)).max(20), enabled: z.boolean() }).strict();
const outputSchema = z.object({ proposalId: z.string().uuid(), reviewDigest: z.string().min(1).max(200), expiresAt: z.string().datetime(), review: z.object({ kind: z.enum(["create", "edit", "set_enabled", "remove"]), target: z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable(), name: z.string().max(200) }).strict(), before: directiveView.nullable(), after: directiveView.nullable(), replaces: z.array(z.string().max(200)).max(100), referencedBy: z.array(z.object({ directiveId: z.string().uuid(), name: z.string().max(200), relation: z.enum(["excludes", "dependsOn"]) }).strict()).max(100), referencedByTruncated: z.boolean(), coherence: z.object({ status: z.enum(["coherent", "conflicts", "not_checked", "unavailable"]), conflicts: z.array(z.object({ directiveName: z.string().max(200), reason: z.string().max(1_000) }).strict()).max(10), rationale: z.string().max(2_000) }).strict(), drafting: z.enum(["verbatim", "coach"]), lifecycle: z.literal("agent_draft"), publicationRequired: z.literal(true), irreversible: z.boolean() }).strict() }).strict();

const boundedText = (value: string, max: number): string => value.slice(0, max);
const view = (directive: AuthoredDirective | AuthoredDirectiveInput | null) => directive === null ? null : directiveView.parse({ name: boundedText(directive.name, 200), condition: directive.condition, action: boundedText(directive.action, 4_000), priority: directive.priority ?? null, excludes: (directive.excludes ?? []).slice(0, 100).map((value) => boundedText(value, 200)), tags: (directive.tags ?? []).slice(0, 100).map((value) => boundedText(value, 200)), surfaces: (directive.surfaces ?? []).slice(0, 20), enabled: directive.enabled ?? true });

export interface DirectiveReviewedPreparationDependencies extends ReviewedPreparationDependencies {
  readonly directiveAuthor: Pick<DirectiveAuthorService, "draftForProposal">;
  readonly directives: Pick<AuthoredDirectiveService, "previewChange">;
}

export const createDirectiveReviewedPreparationTool = (deps: DirectiveReviewedPreparationDependencies): CopilotToolDescriptor<z.input<typeof inputSchema>, z.infer<typeof outputSchema>> => ({
  name: NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing directive", contributingModule: "directives",
  description: DESCRIPTION,
  inputSchema, outputSchema, requiredPermissions: ["workspace.agents.manage"], dashboardSubject: { type: "agent" }, surfaces: ["mcp"],
  describeEntity: (input) => ({ type: "agent", id: input.agentId }),
  reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
    const recovered = await recoverReviewedPreparation({ deps, invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: NAME, inputDigest: invocation.inputDigest, staleBefore, now });
    if (recovered.status !== "recovered" || recovered.proposal.targetType !== "directive" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
    const review = outputSchema.shape.review.safeParse(recovered.proposal.reviewSnapshot);
    return review.success ? { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), review: review.data } } : { status: "conflict" };
  },
  createTool: (context) => ({ name: NAME, description: DESCRIPTION, inputSchema, outputSchema, invoke: async (raw) => {
    const input = inputSchema.parse(raw); await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
    let payload: Record<string, unknown>; let before: AuthoredDirective | null; let after: AuthoredDirectiveInput | null; let coherence: { status: "coherent" | "conflicts" | "not_checked" | "unavailable"; conflicts: ReadonlyArray<{ directiveName: string; reason: string }>; rationale: string }; let referencedBy: ReadonlyArray<{ directiveId: string; name: string; relation: "excludes" | "dependsOn" }>; let referencedByTotal: number; let name: string; let versionToken: string; let drafting: "verbatim" | "coach"; let irreversible: boolean;
    if (input.kind === "create" || input.kind === "edit") {
      const drafted = await deps.directiveAuthor.draftForProposal(context.workspaceId, input.agentId, { ...projectDirectiveAuthorProposalInput(input), ...(input.kind === "edit" ? { directiveId: input.directiveId! } : {}) });
      const proposed = drafted.draft.directive as AuthoredDirectiveInput;
      const preview = await deps.directives.previewChange(context.workspaceId, input.agentId, { kind: "save", directiveId: input.kind === "edit" ? input.directiveId! : null, input: proposed, versionToken: drafted.versionToken });
      ({ before, after, coherence, referencedBy, referencedByTotal, irreversible, versionToken } = preview); drafting = drafted.drafting; name = after!.name;
      payload = { ...proposed, ...(input.rationale === undefined ? {} : { rationale: input.rationale }) };
    } else if (input.kind === "set_enabled") {
      const preview = await deps.directives.previewChange(context.workspaceId, input.agentId, { kind: "set_enabled", directiveId: input.directiveId!, enabled: input.enabled! });
      ({ before, after, coherence, referencedBy, referencedByTotal, drafting, irreversible, versionToken } = preview); name = after!.name;
      payload = { op: "set_enabled", enabled: input.enabled, name, ...(input.rationale === undefined ? {} : { rationale: input.rationale }) };
    } else {
      const preview = await deps.directives.previewChange(context.workspaceId, input.agentId, { kind: "remove", directiveId: input.directiveId! });
      ({ before, after, coherence, referencedBy, referencedByTotal, drafting, irreversible, versionToken } = preview); name = before!.name;
      payload = { op: "remove", removesTarget: true, name, ...(input.rationale === undefined ? {} : { rationale: input.rationale }) };
    }
    const boundedReferences = referencedBy.slice(0, 100);
    const review = outputSchema.shape.review.parse({ kind: input.kind, target: { agentId: input.agentId, directiveId: input.kind === "create" ? null : input.directiveId!, name: boundedText(name, 200) }, before: view(before), after: view(after), replaces: (after?.excludes ?? []).slice(0, 100).map((value) => boundedText(value, 200)), referencedBy: boundedReferences.map((reference) => ({ directiveId: reference.directiveId, name: boundedText(reference.name, 200), relation: reference.relation })), referencedByTruncated: referencedByTotal > boundedReferences.length, coherence: { status: coherence.status, conflicts: coherence.conflicts.slice(0, 10).map((conflict) => ({ directiveName: boundedText(conflict.directiveName, 200), reason: boundedText(conflict.reason, 1_000) })), rationale: boundedText(coherence.rationale, 2_000) }, drafting, lifecycle: "agent_draft", publicationRequired: true, irreversible });
    await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
    const stored = await persistReviewedPreparation({ deps, context, targetType: "directive", targetRef: { agentId: input.agentId, directiveId: input.kind === "create" ? null : input.directiveId! }, payload, versionToken, reviewSnapshot: review, operation: NAME, metadata: { directiveKind: input.kind, ...(input.kind === "create" ? {} : { directiveId: input.directiveId! }) } });
    return { proposalId: stored.proposal.id, reviewDigest: stored.reviewDigest, expiresAt: stored.expiresAt.toISOString(), review };
  } }),
});
