import {
  copilotTimeZoneSettingChangeSchema,
  copilotTimeZoneSettingPayloadSchema,
  type CopilotTimeZoneSettingPayload,
} from "../contracts/timeZoneSettingAuthoring.js";
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

const MANAGE_SETTINGS = ["workspace.settings.manage"] as const;
const NAME = "propose_time_zone_setting";
const LABEL = "Time zone";
const DESCRIPTION = "Propose the IANA time zone the workspace reads today's date in, for the operator to review and apply. Relative dates in a question (today, tomorrow, this weekend, next week) resolve against today's date in this zone, in the query rewrite, the answer, the rerank, the date-range lookup, the today() metadata rule token, and a routine's date slots and lookups; it also anchors a document's relative dates, such as next Friday, to its creation day when the document is enriched. A visitor whose browser or API call reports a valid zone (Test Chat sends the operator's browser zone) reads today in their own zone instead, and a routine resumed by an approval click reads the zone of the visitor's last message first; this zone covers everyone else (email, Slack, voice, the Retrieval API, evals, and visitors whose client reports none). timeZone is an IANA name such as Europe/Rome or America/Los_Angeles; null reads today in UTC, the default. Read the current value from workspace_settings (timeZone.timeZone) first, and propose the zone where the workspace's visitors or events are when the operator names it or asks why dates come out a day off.";

interface TimeZoneSettingProposalCopilotToolDependencies extends CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
}

const summarize = (payload: CopilotTimeZoneSettingPayload): string => {
  const summary = payload.timeZone === null
    ? "Read today's date in UTC for visitors whose client reports no time zone."
    : `Read today's date in ${payload.timeZone} for visitors whose client reports no time zone.`;
  return payload.rationale ? `${summary} ${payload.rationale}` : summary;
};

export const createTimeZoneSettingProposalCopilotTools = (
  deps: TimeZoneSettingProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "time_zone_setting");
  const shared = {
    name: NAME,
    description: DESCRIPTION,
    inputSchema: copilotTimeZoneSettingChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    verificationCost: () => 0,
    uiLabel: "Drafting a time zone change",
    contributingModule: "settings",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_SETTINGS],
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
      if (recovery.proposal.targetType !== "time_zone_setting") return { status: "conflict" };
      const payload = copilotTimeZoneSettingPayloadSchema.safeParse(recovery.proposal.payload);
      // The live call always stores the summary it returned; a payload without one cannot be
      // answered with the response the first attempt gave.
      if (!payload.success || !payload.data.summary) return { status: "conflict" };
      return {
        status: "recovered",
        output: { proposalId: recovery.proposal.id, targetType: "time_zone_setting" as const, targetLabel: LABEL, summary: payload.data.summary },
      };
    },
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotTimeZoneSettingChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        // validatePayload is the version-token source and the refusal for a change that names no
        // zone, restates the stored one, or names one the runtime's IANA zone data does not know.
        const validated = await adapter.validatePayload(context.workspaceId, {}, change);
        const payload = validated.payload as CopilotTimeZoneSettingPayload;
        const summary = boundedSummary(summarize(payload));
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          origin: copilotProposalOrigin(context),
          targetType: "time_zone_setting",
          targetRef: validated.targetRef,
          payload: copilotTimeZoneSettingPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // A workspace zone installs through no agent config override, so no replay measures it.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return { proposalId: proposal.id, targetType: "time_zone_setting" as const, targetLabel: LABEL, summary };
      },
    }),
  }];
};
