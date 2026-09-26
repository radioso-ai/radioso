import {
  copilotIngestionSettingsChangeSchema,
  copilotIngestionSettingsPayloadSchema,
  copilotIngestionSettingsTargetRefSchema,
  type CopilotIngestionSettingsPayload,
} from "./contracts/ingestionSettingsAuthoring.js";
import type { CopilotIngestionSettingsProposalAdapter } from "./contracts.js";
import type {
  IngestionSettingsFieldProposalApplyInput,
  IngestionSettingsFieldProposalApplyOutcome,
  IngestionSettingsFieldProposalPreparation,
  IngestionSettingsProposalPatch,
} from "../settings/contracts/services.js";

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
    applyFieldProposal(workspaceId: string, prepared: IngestionSettingsFieldProposalApplyInput): Promise<IngestionSettingsFieldProposalApplyOutcome>;
  };
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
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const payload = copilotIngestionSettingsPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.ingestionSettings.applyFieldProposal(workspaceId, {
        normalizedPatch: domainFields(payload),
        ...(targetRef.expectedFields
          ? { expected: targetRef.expectedFields }
          : { expectedUpdatedAt: new Date(token) }),
      });
      if (result.status === "applied") return { outcome: "applied" as const, appliedRef: { workspaceId } };
      return stale(result);
    } catch (error) {
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
});
