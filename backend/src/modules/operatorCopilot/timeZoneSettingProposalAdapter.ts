import {
  copilotTimeZoneSettingChangeSchema,
  copilotTimeZoneSettingPayloadSchema,
  copilotTimeZoneSettingTargetRefSchema,
  type CopilotTimeZoneSettingPort,
} from "./contracts/timeZoneSettingAuthoring.js";
import type { CopilotTimeZoneSettingProposalAdapter } from "./contracts.js";

const label = "Time zone" as const;

/** Thin persistence and presentation adapter; validation, the compare-and-set and the audit stay with the time zone settings. */
export const createTimeZoneSettingCopilotProposalAdapter = (deps: {
  readonly timeZoneSettings: CopilotTimeZoneSettingPort;
}): CopilotTimeZoneSettingProposalAdapter => ({
  targetType: "time_zone_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    copilotTimeZoneSettingTargetRefSchema.parse(rawTargetRef);
    return deps.timeZoneSettings.readFieldProposalVersion(workspaceId);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotTimeZoneSettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotTimeZoneSettingPayloadSchema.parse(rawPayload);
    return {
      targetLabel: label,
      current: { ...await deps.timeZoneSettings.readFieldProposalDisplay(workspaceId) },
      proposed: { timeZone: payload.timeZone },
    };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = copilotTimeZoneSettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotTimeZoneSettingPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.timeZoneSettings.applyFieldProposal(workspaceId, {
        normalized: { timeZone: payload.timeZone },
        expected: targetRef.expectedFields,
      });
      if (result.status === "applied") return { outcome: "applied" as const, appliedRef: { workspaceId } };
      if (result.status === "target_deleted") return { outcome: "stale" as const, reason: "Target deleted" };
      return { outcome: "stale" as const, reason: `Field changed: ${result.fields.join(", ")}` };
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Time zone apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    void rawTargetRef;
    const { rationale, ...patch } = copilotTimeZoneSettingChangeSchema.parse(rawChange);
    const prepared = await deps.timeZoneSettings.prepareFieldProposal(workspaceId, patch);
    const payload = copilotTimeZoneSettingPayloadSchema.parse({
      name: label,
      timeZone: prepared.normalized.timeZone,
      ...(rationale === undefined ? {} : { rationale }),
    });
    return {
      targetRef: { expectedFields: prepared.expected },
      payload,
      versionToken: await deps.timeZoneSettings.readFieldProposalVersion(workspaceId),
    };
  },
});
