import {
  copilotWorkspaceSettingChangeSchema,
  copilotWorkspaceSettingPayloadSchema,
  copilotWorkspaceSettingReachFields,
  copilotWorkspaceSettingTargetRefSchema,
  type CopilotWorkspaceSettingChange,
  type CopilotWorkspaceSettingPayload,
  type CopilotWorkspaceSettingPort,
  type CopilotWorkspaceSettingSnapshot,
} from "./contracts/workspaceSettingAuthoring.js";
import type { CopilotWorkspaceSettingProposalAdapter } from "./contracts.js";
import { isStale, versionInstant, versionToken } from "./proposalVersioning.js";
import { validateWebsiteEmbedSettings } from "../settings/public.js";
import { AppError, badRequest } from "../../shared/domain/errors.js";

/** See the document adapter: a read that failed is not a target that vanished. */
const readOrMissing = async <T>(read: Promise<T>): Promise<T | null> => {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") return null;
    throw error;
  }
};

const WORKSPACE_SETTINGS_LABEL = "Workspace settings" as const;
/** The fields whose combination the embed domain judges, so a refusal can say whose fault it is. */
const embedFieldNames = ["websiteEmbedEnabled", "websiteEmbedAllowedOrigins", "websiteEmbedLauncherLabel", "websiteEmbedLauncherPosition"] as const;
const TARGET_LABEL = WORKSPACE_SETTINGS_LABEL;

/** The card's own presentation fields are not settings, so a diff must not list them as changes. */
const domainFields = (payload: CopilotWorkspaceSettingPayload): Record<string, unknown> => {
  const { name: _name, rationale: _rationale, summary: _summary, changesReach: _changesReach, ...fields } = payload;
  return fields;
};

export interface WorkspaceSettingCopilotProposalAdapterDependencies {
  readonly workspaceSetting: CopilotWorkspaceSettingPort;
}

/** The stored settings as the payload states them, so current and proposed compare field for field. */
const settled = (settings: CopilotWorkspaceSettingSnapshot): Omit<CopilotWorkspaceSettingPayload, "changesReach"> =>
  copilotWorkspaceSettingPayloadSchema.omit({ changesReach: true }).parse({
    name: WORKSPACE_SETTINGS_LABEL,
    assistantName: settings.assistantName,
    greetingInstruction: settings.greetingInstruction,
    assistantDefaultLocale: settings.assistantDefaultLocale,
    proactiveGreetingEnabled: settings.proactiveGreetingEnabled,
    suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
    customInstruction: settings.customInstruction,
    anonymousChatEnabled: settings.anonymousChatEnabled,
    websiteEmbedEnabled: settings.websiteEmbedEnabled,
    websiteEmbedAllowedOrigins: [...settings.websiteEmbedAllowedOrigins],
    websiteEmbedLauncherLabel: settings.websiteEmbedLauncherLabel,
    websiteEmbedLauncherPosition: settings.websiteEmbedLauncherPosition,
  });

/** The fields a payload states differently from what is stored. */
export const changedWorkspaceSettingKeys = (
  settings: CopilotWorkspaceSettingSnapshot,
  payload: Omit<CopilotWorkspaceSettingPayload, "changesReach">,
): ReadonlyArray<string> => {
  const current = settled(settings) as Record<string, unknown>;
  return Object.entries(payload)
    .filter(([key]) => key !== "rationale" && key !== "name" && key !== "summary")
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key]))
    .map(([key]) => key);
};

/** Whether the changed fields include one that decides who can reach the agent at all. */
export const changesWorkspaceReach = (changed: ReadonlyArray<string>): boolean =>
  changed.some((key) => (copilotWorkspaceSettingReachFields as ReadonlyArray<string>).includes(key));

/**
 * The write replaces the assistant and channel sections at once, so a proposal that named one field
 * has to carry the rest. Merging only the keys the change actually names keeps an absent field
 * meaning "leave it alone" rather than "reset it to whatever the payload happens to hold".
 *
 * The embed fields go through the settings domain's own validator on the way, for the same reason
 * the ingestion adapter runs `validateIngestionSettings`: it owns rules a single field cannot
 * express - an enabled embed needs at least one origin - and it normalizes what it is given, so an
 * origin written as `https://example.com/path` settles to `https://example.com`. Diffing before
 * that normalization would report a change the write does not make, and would state reach for it.
 * The token it settles is discarded: this payload has no field to carry one.
 */
const merged = (
  settings: CopilotWorkspaceSettingSnapshot,
  change: CopilotWorkspaceSettingChange,
): Omit<CopilotWorkspaceSettingPayload, "changesReach"> => {
  const { rationale: _rationale, ...fields } = change;
  const named = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const requested = { ...settled(settings), ...named };
  let embed;
  try {
    embed = validateWebsiteEmbedSettings({
      websiteEmbedEnabled: requested.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: [...requested.websiteEmbedAllowedOrigins],
      websiteEmbedLauncherLabel: requested.websiteEmbedLauncherLabel,
      websiteEmbedLauncherPosition: requested.websiteEmbedLauncherPosition,
    });
  } catch (error) {
    // Refused at draft time rather than at Apply, so a combination that could only ever fail never
    // reaches an operator's card. The stored surface can already hold one the domain refuses — an
    // enabled embed with no origin, which the read path tolerates and the write path does not — and
    // then every settings write is blocked, not just this one. Saying so is the difference between
    // a card the operator can act on and an allowed-origin error attached to a greeting change.
    const reason = error instanceof Error ? error.message : "The proposed embed settings are not valid";
    throw badRequest(embedFieldNames.some((field) => field in named)
      ? reason
      : `The workspace's stored website embed settings block any settings change until they are fixed: ${reason}`);
  }
  return copilotWorkspaceSettingPayloadSchema.omit({ changesReach: true }).parse({
    ...requested,
    websiteEmbedEnabled: embed.websiteEmbedEnabled,
    websiteEmbedAllowedOrigins: embed.websiteEmbedAllowedOrigins,
    websiteEmbedLauncherLabel: embed.websiteEmbedLauncherLabel,
    websiteEmbedLauncherPosition: embed.websiteEmbedLauncherPosition,
    name: WORKSPACE_SETTINGS_LABEL,
    ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
  });
};

export const createWorkspaceSettingCopilotProposalAdapter = (
  deps: WorkspaceSettingCopilotProposalAdapterDependencies,
): CopilotWorkspaceSettingProposalAdapter => ({
  targetType: "workspace_setting",

  async readVersionToken(workspaceId, rawTargetRef) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    return versionToken((await deps.workspaceSetting.getForWorkspace(workspaceId)).updatedAt);
  },

  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWorkspaceSettingPayloadSchema.parse(rawPayload);
    const settings = await readOrMissing(deps.workspaceSetting.getForWorkspace(workspaceId));
    return {
      targetLabel: TARGET_LABEL,
      current: settings ? domainFields({ ...settled(settings), changesReach: false }) : null,
      proposed: domainFields(payload),
    };
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    // Parsing before the write is what strips anything the payload should not carry — the channel
    // tokens above all, whose absence is the reason applying this can never rotate one.
    const payload = copilotWorkspaceSettingPayloadSchema.parse(rawPayload);
    try {
      // A conditional update, not read-compare-then-write: the drafted version reaches the write's
      // own predicate, so a surface that moved in between is refused there rather than replaced by
      // the whole-object values this payload has been carrying since the draft.
      const expectedUpdatedAt = versionInstant(token);
      if (!expectedUpdatedAt) return { outcome: "stale" as const };
      await deps.workspaceSetting.updateForWorkspace(workspaceId, payload, { expectedUpdatedAt });
      return { outcome: "applied" as const, appliedRef: { workspaceId } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Workspace settings apply failed" };
    }
  },

  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    copilotWorkspaceSettingTargetRefSchema.parse(rawTargetRef);
    const change = copilotWorkspaceSettingChangeSchema.parse(rawChange);
    const { rationale: _rationale, ...fields } = change;
    if (Object.values(fields).every((value) => value === undefined)) {
      throw badRequest("Name at least one workspace setting to change");
    }
    // The token comes from this same read: the merge is built from it, and pairing that merge with
    // a later token would let an edit that landed in between pass the apply-time version check.
    const settings = await deps.workspaceSetting.getForWorkspace(workspaceId);
    const surface = merged(settings, change);
    const changed = changedWorkspaceSettingKeys(settings, surface);
    if (changed.length === 0) {
      throw badRequest("The workspace settings already hold these values");
    }
    // Derived here rather than at the card, so the signal is decided once against the stored state
    // the draft was made from — a later reader comparing against fresher settings could conclude
    // the opposite about the same proposal.
    const payload = copilotWorkspaceSettingPayloadSchema.parse({ ...surface, changesReach: changesWorkspaceReach(changed) });
    return { targetRef: {}, payload, versionToken: versionToken(settings.updatedAt) };
  },
});
