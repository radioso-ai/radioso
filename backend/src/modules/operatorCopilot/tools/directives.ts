import { z } from "zod";

import type {
  CopilotMcpProposalRecoveryPort,
  CopilotToolDescriptor,
} from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  describeNamedAgent,
  entity,
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
export interface DirectiveProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies, CopilotProposalToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
}

/**
 * Mirrors the payload shape each directive proposal tool persists (see directivePayload,
 * isDirectiveRemoval, and isDirectiveEnablement in proposalAdapters.ts). Parsed defensively during
 * MCP retry-recovery: an unexpected shape means the recovered proposal was not written by this
 * descriptor, so reconciliation reports a conflict rather than reconstructing the wrong card.
 */
const directiveDraftPayloadSchema = z.object({
  name: z.string(),
  rationale: z.string(),
  // A save payload never carries `op`; only removal/enablement payloads do. Requiring it be
  // undefined keeps this schema from accidentally matching one of those.
  op: z.undefined().optional(),
}).passthrough();
const directiveRemovalPayloadSchema = z.object({
  op: z.literal("remove"),
  name: z.string(),
  rationale: z.string(),
}).passthrough();
const directiveEnablementPayloadSchema = z.object({
  op: z.literal("set_enabled"),
  enabled: z.boolean(),
  name: z.string(),
  rationale: z.string(),
}).passthrough();
const describeDirectiveToolAgent = (
  deps: Pick<DirectiveProposalCopilotToolDependencies, "agentLookup">,
  input: { agentId?: string; agentName?: string },
  context: Parameters<NonNullable<CopilotToolDescriptor["describeEntity"]>>[1],
) => input.agentName
  ? describeNamedAgent(input, context, deps.agentLookup)
  : entity("agent", input.agentId ?? context?.pageContext.agentId);

export const createDirectiveProposalCopilotTools = (
  deps: DirectiveProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapterFor(deps.proposalAdapters, "directive");
  return [
    {
      name: "propose_directive", shape: "propose", verificationCost: () => 0, uiLabel: "Drafting a directive", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: `Draft a directive proposal for the operator to review and apply. This does not change configuration. ${scopedAgentDraftPublicationNote}`,
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_directive",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        if (recovery.proposal.targetType !== "directive") return { status: "conflict" };
        const payload = directiveDraftPayloadSchema.safeParse(recovery.proposal.payload);
        if (!payload.success) return { status: "conflict" };
        return {
          status: "recovered",
          output: {
            proposalId: recovery.proposal.id,
            targetType: "directive" as const,
            targetLabel: payload.data.name,
            summary: payload.data.rationale,
            ...proposalEvidenceOutput(recovery.proposal.evidence),
          },
        };
      },
      createTool: (context) => ({
        name: "propose_directive",
      description: `Draft a directive proposal for the operator to review and apply. This does not change configuration. ${scopedAgentDraftPublicationNote}`,
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, intent, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId: directiveId ?? null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await directiveAdapter.draft(context.workspaceId, targetRef, intent);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "directive" });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            origin: copilotProposalOrigin(context),
            targetType: "directive",
            targetRef,
            payload: draft.payload,
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: draft.targetLabel, summary: draft.summary, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => describeDirectiveToolAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
    {
      name: "propose_directive_removal", shape: "propose", verificationCost: () => 0, uiLabel: "Proposing directive removal", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: `Propose removing a directive from the agent draft. If the goal is to stop a directive from firing, use propose_directive_enablement with enabled: false instead: disabling is reversible and preserves the authored text. The current published revision and ongoing conversations retain the directive until Review & Publish; applying this proposal changes the draft only. ${scopedAgentDraftPublicationNote}`,
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_directive_removal",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        if (recovery.proposal.targetType !== "directive") return { status: "conflict" };
        const payload = directiveRemovalPayloadSchema.safeParse(recovery.proposal.payload);
        if (!payload.success) return { status: "conflict" };
        return {
          status: "recovered",
          output: {
            proposalId: recovery.proposal.id,
            targetType: "directive" as const,
            targetLabel: payload.data.name,
            summary: payload.data.rationale,
            removal: true as const,
            ...proposalEvidenceOutput(recovery.proposal.evidence),
          },
        };
      },
      createTool: (context) => ({
        name: "propose_directive_removal",
        description: `Propose removing a directive from the agent draft. If the goal is to stop a directive from firing, use propose_directive_enablement with enabled: false instead: disabling is reversible and preserves the authored text. The current published revision and ongoing conversations retain the directive until Review & Publish; applying this proposal changes the draft only. ${scopedAgentDraftPublicationNote}`,
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          // Throws when the directive does not exist, or belongs to a different agent, so the tool
          // fails clearly instead of silently proposing to remove nothing.
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const preview = await directiveAdapter.preview(context.workspaceId, targetRef, { op: "remove" });
          const summary = `Remove the directive "${preview.targetLabel}" from the agent draft. The current published revision and ongoing conversations retain it until Review & Publish.`;
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "directive", directiveId });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            origin: copilotProposalOrigin(context),
            targetType: "directive",
            targetRef,
            payload: { op: "remove" as const, removesTarget: true as const, name: preview.targetLabel, rationale: summary },
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: preview.targetLabel, summary, removal: true as const, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => describeDirectiveToolAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
    {
      name: "propose_directive_enablement", shape: "propose", verificationCost: () => 0, uiLabel: "Proposing directive enablement", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: `Propose enabling or disabling an existing directive for operator review. Disabling is reversible and keeps the directive configured; re-enabling validates its binding again before it can fire. Applying this proposal changes the agent draft only; the current published revision and ongoing conversations retain the current behavior until Review & Publish. ${scopedAgentDraftPublicationNote}`,
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, enabled: z.boolean(), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
        if (!invocation.operationId) return { status: "conflict" };
        const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
          invocationId: invocation.id,
          grantId: invocation.grantId,
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          operationId: invocation.operationId,
          descriptorName: "propose_directive_enablement",
          inputDigest: invocation.inputDigest,
          staleBefore,
          now,
        });
        if (recovery.status !== "recovered") return recovery;
        if (recovery.proposal.targetType !== "directive") return { status: "conflict" };
        const payload = directiveEnablementPayloadSchema.safeParse(recovery.proposal.payload);
        if (!payload.success) return { status: "conflict" };
        return {
          status: "recovered",
          output: {
            proposalId: recovery.proposal.id,
            targetType: "directive" as const,
            targetLabel: payload.data.name,
            summary: payload.data.rationale,
            ...proposalEvidenceOutput(recovery.proposal.evidence),
          },
        };
      },
      createTool: (context) => ({
        name: "propose_directive_enablement",
        description: `Propose enabling or disabling an existing directive for operator review. Disabling is reversible and keeps the directive configured; re-enabling validates its binding again before it can fire. Applying this proposal changes the agent draft only; the current published revision and ongoing conversations retain the current behavior until Review & Publish. ${scopedAgentDraftPublicationNote}`,
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, enabled: z.boolean(), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, enabled, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          // The version read is also the authoritative target existence and ownership check.
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const preview = await directiveAdapter.preview(context.workspaceId, targetRef, { op: "set_enabled", enabled });
          const currentEnabled = (preview.current as { enabled?: unknown } | null)?.enabled;
          if (currentEnabled === enabled) {
            throw new Error(`The directive "${preview.targetLabel}" is already ${enabled ? "enabled" : "disabled"}.`);
          }
          const summary = `${enabled ? "Enable" : "Disable"} the directive "${preview.targetLabel}"${enabled ? ". Its binding will be revalidated before it can fire." : ". Its configured text will be preserved and it can be re-enabled later."}`;
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "directive", directiveId, directiveEnabled: enabled });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            origin: copilotProposalOrigin(context),
            targetType: "directive",
            targetRef,
            payload: { op: "set_enabled" as const, enabled, name: preview.targetLabel, rationale: summary },
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: preview.targetLabel, summary, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => describeDirectiveToolAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
  ];
};
