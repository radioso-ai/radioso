import {
  copilotPrivacySettingChangeSchema,
  copilotPrivacySettingPayloadSchema,
  copilotPrivacySettingTargetRefSchema,
  type CopilotPrivacySettingPort,
} from "./contracts/privacySettingAuthoring.js";
import type { CopilotPrivacySettingProposalAdapter } from "./contracts.js";

const label = "Privacy settings" as const;

/** A window set where there was none, or shortened, lets the sweep erase conversations it kept before. */
const erasesSooner = (current: number | null, proposed: number | null): boolean =>
  proposed !== null && (current === null || proposed < current);

/** Thin persistence and presentation adapter; validation, the compare-and-set and the audit stay with the privacy settings. */
export const createPrivacySettingCopilotProposalAdapter = (deps: {
  readonly privacySettings: CopilotPrivacySettingPort;
}): CopilotPrivacySettingProposalAdapter => ({
  targetType: "privacy_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    copilotPrivacySettingTargetRefSchema.parse(rawTargetRef);
    return deps.privacySettings.readFieldProposalVersion(workspaceId);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotPrivacySettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotPrivacySettingPayloadSchema.parse(rawPayload);
    return {
      targetLabel: label,
      current: { ...await deps.privacySettings.readFieldProposalDisplay(workspaceId) },
      proposed: { conversationRetentionDays: payload.conversationRetentionDays },
    };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = copilotPrivacySettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotPrivacySettingPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.privacySettings.applyFieldProposal(workspaceId, {
        normalized: { conversationRetentionDays: payload.conversationRetentionDays },
        expected: targetRef.expectedFields,
      });
      if (result.status === "applied") return { outcome: "applied" as const, appliedRef: { workspaceId } };
      if (result.status === "target_deleted") return { outcome: "stale" as const, reason: "Target deleted" };
      return { outcome: "stale" as const, reason: `Field changed: ${result.fields.join(", ")}` };
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Privacy settings apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    void rawTargetRef;
    const { rationale, ...patch } = copilotPrivacySettingChangeSchema.parse(rawChange);
    const prepared = await deps.privacySettings.prepareFieldProposal(workspaceId, patch);
    const payload = copilotPrivacySettingPayloadSchema.parse({
      name: label,
      conversationRetentionDays: prepared.normalized.conversationRetentionDays,
      erasesSooner: erasesSooner(prepared.current.conversationRetentionDays, prepared.normalized.conversationRetentionDays),
      ...(rationale === undefined ? {} : { rationale }),
    });
    return {
      targetRef: { expectedFields: prepared.expected },
      payload,
      versionToken: await deps.privacySettings.readFieldProposalVersion(workspaceId),
    };
  },
});
