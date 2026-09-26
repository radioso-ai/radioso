import {
  copilotIngestionSettingsChangeSchema,
  copilotIngestionSettingsPayloadSchema,
  copilotIngestionSettingsTargetRefSchema,
  type CopilotIngestionSettingsPayload,
} from "./contracts/ingestionSettingsAuthoring.js";
import type { CopilotIngestionSettingsProposalAdapter, CopilotProposalApplyContext, CopilotReviewedReceiptPort } from "./contracts.js";
import type {
  IngestionSettingsFieldProposalApplyInput,
  IngestionSettingsFieldProposalApplyOutcome,
  IngestionSettingsFieldProposalPreparation,
  IngestionSettingsProposalPatch,
} from "../settings/contracts/services.js";
import { reviewedApplyError, reviewedCommitHook } from "./reviewedAtomicApply.js";

const label = "Ingestion settings" as const;
const presentationKeys = new Set(["name", "rationale", "summary"]);
const domainFields = (payload: CopilotIngestionSettingsPayload): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => !presentationKeys.has(key)));
const stale = (result: Exclude<IngestionSettingsFieldProposalApplyOutcome, { status: "applied" }>) => {
  if (result.status === "target_deleted") return { outcome: "stale" as const, reason: "Target deleted" };
  if (result.status === "target_changed") return { outcome: "stale" as const, reason: "Target changed" };
  return { outcome: "stale" as const, reason: result.fields.length === 1
    ? `Field changed: ${result.fields[0]}` : `Fields changed: ${result.fields.join(", ")}` };
};

interface Dependencies {
  readonly ingestionSettings: {
    prepareFieldProposal(workspaceId: string, patch: IngestionSettingsProposalPatch): Promise<IngestionSettingsFieldProposalPreparation>;
    readFieldProposalVersion(workspaceId: string, expected?: IngestionSettingsProposalPatch): Promise<string>;
    readFieldProposalDisplay(workspaceId: string): Promise<Record<string, unknown>>;
    applyFieldProposal(workspaceId: string, prepared: IngestionSettingsFieldProposalApplyInput, options?: { readonly onCommitted?: import("../../shared/infra/kysely/types.js").OwnerCommitHook<{ readonly workspaceId: string }> }): Promise<IngestionSettingsFieldProposalApplyOutcome>;
  };
  readonly reviewedReceipt?: CopilotReviewedReceiptPort;
}

/** Thin persistence/presentation adapter; ingestion validation, merge, and CAS stay with the owner. */
export const createIngestionSettingsCopilotProposalAdapter = (deps: Dependencies): CopilotIngestionSettingsProposalAdapter => ({
  targetType: "ingestion_settings",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    return deps.ingestionSettings.readFieldProposalVersion(workspaceId, targetRef.expectedFields);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const payload = copilotIngestionSettingsPayloadSchema.parse(rawPayload);
    return { targetLabel: label, current: await deps.ingestionSettings.readFieldProposalDisplay(workspaceId), proposed: domainFields(payload) };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token, context?: CopilotProposalApplyContext) {
    const targetRef = copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const payload = copilotIngestionSettingsPayloadSchema.parse(rawPayload);
    const onCommitted = reviewedCommitHook(deps.reviewedReceipt, context, workspaceId, (committed: { workspaceId: string }) => committed);
    try {
      const prepared = {
        normalizedPatch: domainFields(payload),
        ...(targetRef.expectedFields
          ? { expected: targetRef.expectedFields }
          : { expectedUpdatedAt: new Date(token) }),
      };
      const result = onCommitted
        ? await deps.ingestionSettings.applyFieldProposal(workspaceId, prepared, { onCommitted })
        : await deps.ingestionSettings.applyFieldProposal(workspaceId, prepared);
      if (result.status === "applied") return { outcome: "applied" as const, appliedRef: { workspaceId } };
      return stale(result);
    } catch (error) {
      if (onCommitted) return reviewedApplyError(error);
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Ingestion settings apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const change = copilotIngestionSettingsChangeSchema.parse(rawChange);
    const { rationale, ...patch } = change;
    const prepared = await deps.ingestionSettings.prepareFieldProposal(workspaceId, patch);
    const payload = copilotIngestionSettingsPayloadSchema.parse({
      name: label,
      ...prepared.normalizedPatch,
      ...(rationale === undefined ? {} : { rationale }),
    });
    return {
      targetRef: { expectedFields: prepared.expected },
      payload,
      versionToken: await deps.ingestionSettings.readFieldProposalVersion(workspaceId, prepared.expected),
    };
  },
  async reconcileMcpInterruptedApply() {
    // The owner write and receipt settlement share one transaction; a reclaimed pending receipt
    // proves the earlier claim committed neither side.
    return { outcome: "not_applied" as const };
  },
});
