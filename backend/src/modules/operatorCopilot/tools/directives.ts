import { z } from "zod";

import type {
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
  type CopilotProposalToolDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
export interface DirectiveProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies, CopilotProposalToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
}
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
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive",
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
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
      description: "Propose permanently removing a directive that should not exist at all. If the goal is to stop a directive from firing, use propose_directive_enablement with enabled: false instead: disabling is reversible and preserves the authored text. Drafts nothing; applying removal deletes the directive and this cannot be undone. It drafts a proposal for operator review and changes nothing until the operator applies it.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive_removal",
      description: "Propose permanently removing a directive that should not exist at all. If the goal is to stop a directive from firing, use propose_directive_enablement with enabled: false instead: disabling is reversible and preserves the authored text. Drafts nothing; applying removal deletes the directive and this cannot be undone. It drafts a proposal for operator review and changes nothing until the operator applies it.",
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
          const summary = `Permanently remove the directive "${preview.targetLabel}". This cannot be undone.`;
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
      description: "Propose enabling or disabling an existing directive for operator review. Disabling is reversible and keeps the directive configured; re-enabling validates its binding again before it can fire. It drafts a proposal for operator review and changes nothing until the operator applies it.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, enabled: z.boolean(), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive_enablement",
      description: "Propose enabling or disabling an existing directive for operator review. Disabling is reversible and keeps the directive configured; re-enabling validates its binding again before it can fire. It drafts a proposal for operator review and changes nothing until the operator applies it.",
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
