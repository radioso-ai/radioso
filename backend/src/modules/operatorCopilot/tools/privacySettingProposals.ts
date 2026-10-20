import {
  copilotPrivacySettingChangeSchema,
  copilotPrivacySettingPayloadSchema,
  type CopilotPrivacySettingPayload,
} from "../contracts/privacySettingAuthoring.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  boundedSummary,
  copilotProposalOrigin,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const MANAGE_PRIVACY = ["workspace.settings.manage", "workspace.history.delete"] as const;
const NAME = "propose_privacy_setting";
const LABEL = "Privacy settings";
const DESCRIPTION = "Propose how long the workspace keeps conversations, for the operator to review and apply. conversationRetentionDays is whole days from 7 to 3650 after a conversation's last update or message; past it, a sweep erases the conversation with everything derived from it — messages, summaries, routine state, eval snapshots, inbound mail — with no undo. null keeps conversations until someone deletes them, which is the default. Read the current value from workspace_settings (privacy.conversationRetentionDays) first. Propose a window only when the operator asks for one or asks how to keep less data; never set a shorter window on your own initiative. The card states when the change lets the sweep erase conversations sooner.";

interface PrivacySettingProposalCopilotToolDependencies extends CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
}

const summarize = (payload: CopilotPrivacySettingPayload): string => {
  const days = payload.conversationRetentionDays;
  const change = days === null
    ? "Keep conversations until someone deletes them."
    : `Erase each conversation, with everything derived from it, ${days} days after its last update or message.`;
  const consequence = payload.erasesSooner ? " Conversations already past the window are erased by the next sweep, with no undo." : "";
  const summary = `${change}${consequence}`;
  return payload.rationale ? `${summary} ${payload.rationale}` : summary;
};

export const createPrivacySettingProposalCopilotTools = (
  deps: PrivacySettingProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "privacy_setting");
  const shared = {
    name: NAME,
    description: DESCRIPTION,
    inputSchema: copilotPrivacySettingChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    verificationCost: () => 0,
    uiLabel: "Drafting a privacy settings change",
    contributingModule: "privacy",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_PRIVACY],
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovery = await deps.proposalRecovery.recoverOperatorMcpProposal({
        invocationId: invocation.id,
        grantId: invocation.grantId,
        workspaceId: context.workspaceId,
        operatorUserId: context.operatorUserId,
        operationId: invocation.operationId,
        descriptorName: NAME,
        inputDigest: invocation.inputDigest,
        staleBefore,
        now,
      });
      if (recovery.status !== "recovered") return recovery;
      if (recovery.proposal.targetType !== "privacy_setting") return { status: "conflict" };
      const payload = copilotPrivacySettingPayloadSchema.safeParse(recovery.proposal.payload);
      // The live call always stores the summary it returned; a payload without one cannot be
      // answered with the response the first attempt gave.
      if (!payload.success || !payload.data.summary) return { status: "conflict" };
      return {
        status: "recovered",
        output: { proposalId: recovery.proposal.id, targetType: "privacy_setting" as const, targetLabel: LABEL, summary: payload.data.summary },
      };
    },
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotPrivacySettingChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_PRIVACY]);
        // validatePayload is the version-token source, the merge against stored settings, and the
        // refusal for a change that names nothing, restates what is stored, or leaves the range.
        const validated = await adapter.validatePayload(context.workspaceId, {}, change);
        const payload = validated.payload as CopilotPrivacySettingPayload;
        const summary = boundedSummary(summarize(payload));
        await requireCurrentCopilotPermissions(context, [...MANAGE_PRIVACY]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          origin: copilotProposalOrigin(context),
          targetType: "privacy_setting",
          targetRef: validated.targetRef,
          payload: copilotPrivacySettingPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // A retention window changes no agent behaviour, so no replay measures it.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return { proposalId: proposal.id, targetType: "privacy_setting" as const, targetLabel: LABEL, summary };
      },
    }),
  }];
};
