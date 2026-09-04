import {
  copilotIngestionSettingsChangeSchema,
  copilotIngestionSettingsPayloadSchema,
  type CopilotIngestionSettingsPayload,
} from "../contracts/ingestionSettingsAuthoring.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  boundedSummary,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  copilotProposalOrigin,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const MANAGE_SETTINGS = ["workspace.settings.manage"] as const;
const NAME = "propose_ingestion_settings";
const DESCRIPTION = "Propose a change to how documents are chunked and enriched when they are processed, for the operator to review and apply. Name only the fields you want changed; the rest are carried over from the stored settings. Applying it re-chunks nothing on its own — reprocess a document or a source afterwards for the change to reach what is already indexed.";

export type IngestionSettingsProposalCopilotToolDependencies = CopilotProposalToolDependencies;

const summarize = (payload: CopilotIngestionSettingsPayload, changed: ReadonlyArray<string>): string => {
  const fields = changed.map((key) => `${key} to ${String((payload as Record<string, unknown>)[key])}`).join(", ");
  const summary = `Change ingestion ${fields}.`;
  return payload.rationale ? `${summary} ${payload.rationale}` : summary;
};

export const createIngestionSettingsProposalCopilotTools = (
  deps: IngestionSettingsProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "ingestion_settings");
  const shared = {
    name: NAME,
    description: DESCRIPTION,
    inputSchema: copilotIngestionSettingsChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    verificationCost: () => 0,
    uiLabel: "Drafting an ingestion settings change",
    contributingModule: "settings",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_SETTINGS] as unknown as CopilotToolDescriptor["requiredPermissions"],
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotIngestionSettingsChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        // validatePayload is the version-token source, the merge against stored settings, and the
        // refusal for a change that names nothing or restates what is already stored.
        const validated = await adapter.validatePayload(context.workspaceId, {}, change);
        const payload = validated.payload as CopilotIngestionSettingsPayload;
        const named = Object.keys(change).filter((key) => key !== "rationale" && change[key as keyof typeof change] !== undefined);
        const summary = boundedSummary(summarize(payload, named));
        await requireCurrentCopilotPermissions(context, [...MANAGE_SETTINGS]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          origin: copilotProposalOrigin(context),
          targetType: "ingestion_settings",
          targetRef: validated.targetRef,
          payload: copilotIngestionSettingsPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // Ingestion settings install through no agent config override, so no replay measures them.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: "ingestion_settings" as const,
          targetLabel: "Ingestion settings",
          summary,
        };
      },
    }),
  } as CopilotToolDescriptor];
};
