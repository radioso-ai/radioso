import {
  copilotWorkspaceSettingChangeSchema,
  copilotWorkspaceSettingPayloadSchema,
  copilotWorkspaceSettingTargetRefSchema,
  type CopilotWorkspaceSettingPayload,
} from "./contracts/workspaceSettingAuthoring.js";
import type { CopilotWorkspaceSettingProposalAdapter } from "./contracts.js";
import type {
  PlatformSettingsFieldProposalApplyInput,
  PlatformSettingsFieldProposalApplyOutcome,
  PlatformSettingsFieldProposalPreparation,
  PlatformSettingsProposalPatch,
} from "../settings/contracts/services.js";

const label = "Workspace settings" as const;
const presentationKeys = new Set(["name", "rationale", "summary", "changesReach"]);
const domainFields = (payload: CopilotWorkspaceSettingPayload): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => !presentationKeys.has(key)));
const stale = (result: Exclude<PlatformSettingsFieldProposalApplyOutcome, { status: "applied" }>) => {
  if (result.status === "target_deleted") return { outcome: "stale" as const, reason: "Target deleted" };
  if (result.status === "target_changed") return { outcome: "stale" as const, reason: "Target changed" };
  return { outcome: "stale" as const, reason: result.fields.length === 1
    ? `Field changed: ${result.fields[0]}` : `Fields changed: ${result.fields.join(", ")}` };
};

interface Dependencies {
  readonly workspaceSetting: {
    prepareFieldProposal(workspaceId: string, patch: PlatformSettingsProposalPatch): Promise<PlatformSettingsFieldProposalPreparation>;
    readFieldProposalVersion(workspaceId: string, expected?: PlatformSettingsProposalPatch): Promise<string>;
    readFieldProposalDisplay(workspaceId: string): Promise<Record<string, unknown>>;
    applyFieldProposal(workspaceId: string, prepared: PlatformSettingsFieldProposalApplyInput): Promise<PlatformSettingsFieldProposalApplyOutcome>;
  };
}

/** Thin persistence/presentation adapter; settings validation, diffing, CAS, and side effects stay with the owner. */
export const createWorkspaceSettingCopilotProposalAdapter = (deps: Dependencies): CopilotWorkspaceSettingProposalAdapter => ({
  targetType: "workspace_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    return deps.workspaceSetting.readFieldProposalVersion(workspaceId, targetRef.expectedFields);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWorkspaceSettingPayloadSchema.parse(rawPayload);
    return { targetLabel: label, current: await deps.workspaceSetting.readFieldProposalDisplay(workspaceId), proposed: domainFields(payload) };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWorkspaceSettingPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.workspaceSetting.applyFieldProposal(workspaceId, {
        normalizedPatch: domainFields(payload),
        ...(targetRef.expectedFields
          ? { expected: targetRef.expectedFields }
          : { expectedUpdatedAt: new Date(token) }),
      });
      if (result.status === "applied") return { outcome: "applied" as const, appliedRef: { workspaceId }, ...(result.reason ? { reason: result.reason } : {}) };
      return stale(result);
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Workspace settings apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    const change = copilotWorkspaceSettingChangeSchema.parse(rawChange);
    const { rationale, ...patch } = change;
    const prepared = await deps.workspaceSetting.prepareFieldProposal(workspaceId, patch);
    const payload = copilotWorkspaceSettingPayloadSchema.parse({
      name: label,
      ...prepared.normalizedPatch,
      changesReach: prepared.display.changesReach,
      ...(rationale === undefined ? {} : { rationale }),
    });
    return {
      targetRef: { expectedFields: prepared.expected },
      payload,
      versionToken: await deps.workspaceSetting.readFieldProposalVersion(workspaceId, prepared.expected),
    };
  },
});
