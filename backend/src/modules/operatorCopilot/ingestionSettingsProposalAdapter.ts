import {
  copilotIngestionSettingsChangeSchema,
  copilotIngestionSettingsPayloadSchema,
  copilotIngestionSettingsTargetRefSchema,
  type CopilotIngestionSettingsChange,
  type CopilotIngestionSettingsPayload,
  type CopilotIngestionSettingsPort,
  type CopilotIngestionSettingsSnapshot,
} from "./contracts/ingestionSettingsAuthoring.js";
import type { CopilotIngestionSettingsProposalAdapter } from "./contracts.js";
import { validateIngestionSettings } from "../settings/public.js";
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

const INGESTION_SETTINGS_LABEL = "Ingestion settings" as const;
const TARGET_LABEL = INGESTION_SETTINGS_LABEL;

export interface IngestionSettingsCopilotProposalAdapterDependencies {
  readonly ingestionSettings: CopilotIngestionSettingsPort;
}

const versionToken = (settings: Pick<CopilotIngestionSettingsSnapshot, "updatedAt">): string =>
  settings.updatedAt.toISOString();

/** The stored settings as the payload states them, so current and proposed compare field for field. */
const settled = (settings: CopilotIngestionSettingsSnapshot): CopilotIngestionSettingsPayload =>
  copilotIngestionSettingsPayloadSchema.parse({
    name: INGESTION_SETTINGS_LABEL,
    chunkingStrategy: settings.chunkingStrategy,
    fixedWindowChunkSize: settings.fixedWindowChunkSize,
    fixedWindowChunkOverlap: settings.fixedWindowChunkOverlap,
    structuredMinChunkSize: settings.structuredMinChunkSize,
    structuredMaxChunkSize: settings.structuredMaxChunkSize,
    ...(settings.documentEnrichmentEnabled !== undefined ? { documentEnrichmentEnabled: settings.documentEnrichmentEnabled } : {}),
    ...(settings.manualDocumentEnrichmentOverride !== undefined ? { manualDocumentEnrichmentOverride: settings.manualDocumentEnrichmentOverride } : {}),
  });

/**
 * The write replaces every ingestion field at once, so a proposal that named one has to carry the
 * rest. Merging only the keys the change actually names keeps an absent field meaning "leave it
 * alone" rather than "reset it to whatever the payload happens to hold".
 */
const merged = (
  settings: CopilotIngestionSettingsSnapshot,
  change: CopilotIngestionSettingsChange,
): CopilotIngestionSettingsPayload => {
  const { rationale: _rationale, ...fields } = change;
  const named = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return copilotIngestionSettingsPayloadSchema.parse({
    ...settled(settings),
    ...named,
    name: INGESTION_SETTINGS_LABEL,
    ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
  });
};

/** The fields a payload states differently from what is stored. */
export const changedIngestionSettingKeys = (
  settings: CopilotIngestionSettingsSnapshot,
  payload: CopilotIngestionSettingsPayload,
): ReadonlyArray<string> => {
  const current = settled(settings) as Record<string, unknown>;
  return Object.entries(payload)
    .filter(([key, value]) => key !== "rationale" && key !== "name" && value !== current[key])
    .map(([key]) => key);
};

export const createIngestionSettingsCopilotProposalAdapter = (
  deps: IngestionSettingsCopilotProposalAdapterDependencies,
): CopilotIngestionSettingsProposalAdapter => ({
  targetType: "ingestion_settings",

  async readVersionToken(workspaceId, rawTargetRef) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    return versionToken(await deps.ingestionSettings.getForWorkspace(workspaceId));
  },

  async preview(workspaceId, rawTargetRef, rawPayload) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const payload = copilotIngestionSettingsPayloadSchema.parse(rawPayload);
    const settings = await readOrMissing(deps.ingestionSettings.getForWorkspace(workspaceId));
    return {
      targetLabel: TARGET_LABEL,
      current: settings ? settled(settings) : null,
      proposed: payload,
    };
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    // Parsing before the write is what strips anything the payload should not carry — an embedding
    // model above all, whose absence is the reason applying this can never start a re-embed.
    const payload = copilotIngestionSettingsPayloadSchema.parse(rawPayload);
    try {
      // Read-compare-then-write, not a conditional update: the settings service takes no expected
      // revision, so an edit landing between the two would be overwritten by this payload's carried
      // values. The same window exists on the dashboard's own save.
      const settings = await readOrMissing(deps.ingestionSettings.getForWorkspace(workspaceId));
      if (!settings || versionToken(settings) !== token) return { outcome: "stale" as const };
      await deps.ingestionSettings.updateForWorkspace(workspaceId, payload);
      return { outcome: "applied" as const, appliedRef: { workspaceId } };
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Ingestion settings apply failed" };
    }
  },

  async validatePayload(workspaceId, rawTargetRef, rawChange) {
    copilotIngestionSettingsTargetRefSchema.parse(rawTargetRef);
    const change = copilotIngestionSettingsChangeSchema.parse(rawChange);
    const { rationale: _rationale, ...fields } = change;
    if (Object.values(fields).every((value) => value === undefined)) {
      throw badRequest("Name at least one ingestion setting to change");
    }
    // The token comes from this same read: the merge is built from it, and pairing that merge with
    // a later token would let an edit that landed in between pass the apply-time version check.
    const settings = await deps.ingestionSettings.getForWorkspace(workspaceId);
    const payload = merged(settings, change);
    if (changedIngestionSettingKeys(settings, payload).length === 0) {
      throw badRequest("The ingestion settings already hold these values");
    }
    // The settings domain owns the rules a single field cannot express - an overlap smaller than the
    // window it overlaps, a minimum below its maximum. Checking here rather than restating them
    // means a combination that could only fail on Apply never reaches an operator's card. The
    // result is discarded: it settles an embedding model, which this proposal must never carry.
    validateIngestionSettings({
      chunkingStrategy: payload.chunkingStrategy,
      fixedWindowChunkSize: payload.fixedWindowChunkSize,
      fixedWindowChunkOverlap: payload.fixedWindowChunkOverlap,
      structuredMinChunkSize: payload.structuredMinChunkSize,
      structuredMaxChunkSize: payload.structuredMaxChunkSize,
    });
    return { targetRef: {}, payload, versionToken: versionToken(settings) };
  },
});
