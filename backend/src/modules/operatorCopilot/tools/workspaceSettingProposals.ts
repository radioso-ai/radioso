import {
  copilotWorkspaceSettingChangeSchema,
  copilotWorkspaceSettingPayloadSchema,
  type CopilotWorkspaceSettingPayload,
} from "../contracts/workspaceSettingAuthoring.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  boundedSummary,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const MANAGE_SETTINGS = ["workspace.settings.manage"] as const;
const NAME = "propose_workspace_setting";
const DESCRIPTION = "Propose a change to the workspace's assistant wording or its public channels — assistant name, greeting, default locale, custom instruction, the anonymous chat link, and the website embed's allowed origins and launcher — for the operator to review and apply. Name only the fields you want changed; the rest are carried over from the stored settings. Enabling the anonymous chat link, enabling the embed, or adding an allowed origin changes who can reach the agent, and the card says so. To change the behavior of one agent among several rather than the workspace's own surface, use propose_agent_setting.";

export type WorkspaceSettingProposalCopilotToolDependencies = CopilotProposalToolDependencies;

const stated = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value;
    case "undefined":
      return "undefined";
    case "object":
      if (value === null) return "none";
      if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberate: falls back to default Object stringification for a non-null, non-array settings value
      return String(value);
    default:
      return String(value);
  }
};

const summarize = (payload: CopilotWorkspaceSettingPayload, changed: ReadonlyArray<string>): string => {
  const fields = changed.map((key) => `${key} to ${stated((payload as Record<string, unknown>)[key])}`).join(", ");
  const reach = payload.changesReach ? " This changes who can reach the agent." : "";
  const summary = `Change workspace ${fields}.${reach}`;
  return payload.rationale ? `${summary} ${payload.rationale}` : summary;
};

export const createWorkspaceSettingProposalCopilotTools = (
  deps: WorkspaceSettingProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "workspace_setting");
  const shared = {
    name: NAME,
    description: DESCRIPTION,
    inputSchema: copilotWorkspaceSettingChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    verificationCost: () => 0,
    uiLabel: "Drafting a workspace settings change",
    contributingModule: "settings",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_SETTINGS] as unknown as CopilotToolDescriptor["requiredPermissions"],
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotWorkspaceSettingChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        // validatePayload is the version-token source, the merge against stored settings, the reach
        // determination, and the refusal for a change that names nothing or restates what is stored.
        const validated = await adapter.validatePayload(context.workspaceId, {}, change);
        const payload = validated.payload as CopilotWorkspaceSettingPayload;
        const named = Object.keys(change).filter((key) => key !== "rationale" && change[key as keyof typeof change] !== undefined);
        const summary = boundedSummary(summarize(payload, named));
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          conversationId: requiredCopilotConversation(context),
          targetType: "workspace_setting",
          targetRef: validated.targetRef,
          payload: copilotWorkspaceSettingPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // Workspace settings install through no agent config override, so no replay measures them.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: "workspace_setting" as const,
          targetLabel: "Workspace settings",
          summary,
          // The tool already knows it drafted a reach change, so the card carries that structural
          // signal from the turn that drafted it, not only after a reload.
          ...(payload.changesReach ? { reach: true as const } : {}),
        };
      },
    }),
  }];
};
