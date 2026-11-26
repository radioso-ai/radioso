import { z } from "zod";

import {
  CONTEXT_VARIABLE_SOURCES,
  CONTEXT_VARIABLE_VALUE_TYPES,
  contextVariableOptionSchema,
} from "../../context-variables/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { reviewedConfirmationSchema } from "../reviewedOperation.js";
import type { ReviewedChangeEffect } from "../../../shared/domain/reviewedChangeEffect.js";
import type { AgentContextVariableUsersReader } from "../../agents/public.js";
import { contextVariableDefinitionInputShape, contextVariableEnablementInputSchema } from "./contextVariables.js";
import { persistReviewedPreparation, recoverReviewedPreparation, reviewedPreparationConfirmation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";
import { proposalAdapterFor } from "./shared.js";

const NAME = "prepare_context_variable";
const KINDS = ["create", "edit", "set_enablement"] as const;
const DESCRIPTION = "Prepare a context variable (attribute) change for digest-bound review, applied with execute_reviewed_proposal. kind create: a new definition, optionally with this agent's enablement. kind edit: a definition, by variableId; options restate every existing key (archive an option instead of removing it), and a type cannot change once the attribute has values. kind set_enablement: one agent's source, surfacing and enabled, by variableId. A definition create or edit applies at once to every agent that uses it, so its execution waits for the operator's signed-in approval of the review; review.definition.usedBy lists those agents, each marked by whether its draft, its published release or both use it. An enablement goes to the agent's draft and reaches customers after prepare_agent_publication. Source classified has the AI pick one of a Choice (enum) attribute's options from the conversation after each reply, and is refused for an attribute that is not a Choice, is Private (sensitive) or treated as proof (signed), and past 8 per agent. Read current definitions and enablements with context_variables first.";

const DEFINITION_FIELDS = ["name", "description", "valueType", "options", "trustTier", "sensitivity", "defaultSurfacing"] as const;

const inputSchema = z.object({
  kind: z.enum(KINDS),
  agentId: z.string().uuid(),
  variableId: z.string().uuid().optional(),
  ...contextVariableDefinitionInputShape,
  enablement: contextVariableEnablementInputSchema.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((input, ctx) => {
  const needsId = input.kind !== "create";
  if ((input.variableId !== undefined) !== needsId) {
    if (input.variableId === undefined) ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["variableId"], message: "`variableId` is required for this kind." });
    else ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: ["variableId"], path: [], message: "`variableId` does not belong to kind \"create\"." });
  }
  if (input.kind === "set_enablement") {
    for (const field of DEFINITION_FIELDS) if (input[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: [field], path: [], message: `\`${field}\` does not belong to kind "set_enablement"; prepare a definition with kind "edit".` });
    if (input.enablement === undefined) ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: "object", received: "undefined", path: ["enablement"], message: "`enablement` is required for kind \"set_enablement\"." });
  }
  if (input.kind === "edit" && input.enablement !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: ["enablement"], path: [], message: "`enablement` does not belong to kind \"edit\"; prepare it with kind \"set_enablement\"." });
  }
});

const definitionView = z.object({
  name: z.string().max(120), description: z.string().max(2_000).nullable(), valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES),
  options: z.array(contextVariableOptionSchema).max(50).nullable(), trustTier: z.enum(["unverified", "signed"]),
  sensitivity: z.enum(["normal", "sensitive"]), defaultSurfacing: z.enum(["always", "on_reference", "operator_only"]),
}).strip();
const enablementView = z.object({
  source: z.enum(CONTEXT_VARIABLE_SOURCES), resolverSkillId: z.string().uuid().nullable(), maxAgeSeconds: z.number().int().nullable(),
  resolverTimeoutMs: z.number().int().nullable(), surfacing: z.enum(["always", "on_reference", "operator_only"]), enabled: z.boolean(),
}).strip();
const USED_BY_LIMIT = 25;
const reviewSchema = z.object({
  kind: z.enum(KINDS),
  target: z.object({ agentId: z.string().uuid(), variableId: z.string().uuid().nullable(), name: z.string().max(120) }).strict(),
  /** A definition is workspace-level: a create or edit is live at once for every agent that uses it. */
  definition: z.object({
    before: definitionView.nullable(), after: definitionView, lifecycle: z.literal("live"),
    usedBy: z.array(z.object({ agentId: z.string().uuid(), agentName: z.string().max(200), uses: z.enum(["draft", "published", "both"]) }).strict()).max(USED_BY_LIMIT),
    usedByTruncated: z.boolean(),
  }).strict().nullable(),
  /** One agent's use of it goes to that agent's draft. */
  enablement: z.object({ before: enablementView.nullable(), after: enablementView, lifecycle: z.literal("agent_draft") }).strict().nullable(),
  publicationRequired: z.boolean(),
}).strict();
const outputSchema = z.object({
  proposalId: z.string().uuid(), reviewDigest: z.string().min(1).max(200), expiresAt: z.string().datetime(),
  confirmation: reviewedConfirmationSchema, review: reviewSchema,
}).strict();

type PreparedPayload = { name: string; definition: unknown; enablement: unknown };
type ProposalPreview = { current: { definition: unknown; enablement: unknown } };

/** A definition change is live for every agent; an enablement alone is a reversible draft, as a directive's is. */
const effectOf = (writesDefinition: boolean): ReviewedChangeEffect =>
  ({ exposure: writesDefinition ? "live" : "draft", reversibility: "reversible", metered: false });

export interface ContextVariableReviewedPreparationDependencies extends ReviewedPreparationDependencies {
  /** The agents whose draft or published release enables a variable: a definition edit is live for both. */
  readonly contextVariableUsers: AgentContextVariableUsersReader;
}

export const createContextVariableReviewedPreparationTool = (deps: ContextVariableReviewedPreparationDependencies): CopilotToolDescriptor<z.input<typeof inputSchema>, z.infer<typeof outputSchema>> => {
  const usedBy = async (workspaceId: string, variableId: string | null) => {
    if (!variableId) return { users: [], truncated: false };
    const read = await deps.contextVariableUsers.listContextVariableUsers({ workspaceId, variableId, limit: USED_BY_LIMIT });
    return { users: read.users.map((user) => ({ ...user, agentName: user.agentName.slice(0, 200) })), truncated: read.truncated };
  };

  return {
    name: NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing an attribute", contributingModule: "contextVariables",
    description: DESCRIPTION,
    inputSchema, outputSchema, requiredPermissions: ["workspace.agents.manage"], dashboardSubject: { type: "agent" }, surfaces: ["mcp"],
    describeEntity: (input) => ({ type: "agent", id: input.agentId }),
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      const recovered = await recoverReviewedPreparation({ deps, invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: NAME, inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "context_variable" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const review = reviewSchema.safeParse(recovered.proposal.reviewSnapshot);
      const confirmation = reviewedPreparationConfirmation(deps, recovered.proposal);
      return review.success && confirmation ? { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), confirmation, review: review.data } } : { status: "conflict" };
    },
    createTool: (context) => ({ name: NAME, description: DESCRIPTION, inputSchema, outputSchema, invoke: async (raw) => {
      const input = inputSchema.parse(raw); await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const adapter = proposalAdapterFor(deps.proposalAdapters, "context_variable");
      const { kind, agentId, variableId, enablement, rationale, ...definition } = input;
      const proposed = {
        ...(kind === "set_enablement" ? {} : definition),
        ...(enablement === undefined ? {} : { enablement }),
        ...(rationale === undefined ? {} : { rationale }),
      };
      // The same validation, normalization and version token a dashboard proposal gets: the four
      // classified refusals, the option rules and the has-values type refusal all come from here.
      const validated = await adapter.validatePayload(context.workspaceId, { agentId, variableId: variableId ?? null }, proposed);
      const payload = validated.payload as PreparedPayload;
      const preview = await adapter.preview(context.workspaceId, validated.targetRef, payload) as ProposalPreview;
      const writesDefinition = payload.definition !== null;
      const users = writesDefinition ? await usedBy(context.workspaceId, variableId ?? null) : null;
      const review = reviewSchema.parse({
        kind,
        target: { agentId, variableId: variableId ?? null, name: payload.name },
        definition: writesDefinition ? { before: preview.current.definition, after: payload.definition, lifecycle: "live", usedBy: users!.users, usedByTruncated: users!.truncated } : null,
        enablement: payload.enablement !== null ? { before: preview.current.enablement, after: payload.enablement, lifecycle: "agent_draft" } : null,
        publicationRequired: payload.enablement !== null,
      });
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const stored = await persistReviewedPreparation({ deps, context, targetType: "context_variable", targetRef: validated.targetRef, payload, versionToken: validated.versionToken, reviewSnapshot: review, operation: NAME, metadata: { contextVariableKind: kind, ...(variableId ? { variableId } : {}) }, effect: effectOf(writesDefinition), affectedAgents: { agents: [...(payload.enablement !== null ? [{ id: agentId }] : []), ...(users?.users ?? []).map((user) => ({ id: user.agentId, name: user.agentName }))], truncated: users?.truncated ?? false }, summary: rationale });
      return { proposalId: stored.proposal.id, reviewDigest: stored.reviewDigest, expiresAt: stored.expiresAt.toISOString(), confirmation: stored.confirmation, review };
    } }),
  };
};
