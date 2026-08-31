import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";

import { chunkingStrategyIds } from "../../retrieval/public.js";
import { manualDocumentEnrichmentOverrides } from "../../settings/public.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

const chunking = RETRIEVAL_BEHAVIOR.chunking;

/**
 * The ingestion fields a proposal may carry. The embedding model is absent throughout — reading it
 * belongs to `workspace_settings`, and changing it triggers a bulk re-embed of the whole workspace,
 * which the never-list keeps behind a typed confirmation in the dashboard. Leaving it off the port
 * and the payload means no adapter written against them can start one.
 */
export const copilotIngestionSettingsFields = {
  chunkingStrategy: z.enum(chunkingStrategyIds),
  fixedWindowChunkSize: z.number().int().min(chunking.fixedWindowChunkSizeMin).max(chunking.fixedWindowChunkSizeMax),
  fixedWindowChunkOverlap: z.number().int().min(chunking.fixedWindowChunkOverlapMin).max(chunking.fixedWindowChunkOverlapMax),
  structuredMinChunkSize: z.number().int().min(chunking.structuredMinChunkSizeMin).max(chunking.structuredMinChunkSizeMax),
  structuredMaxChunkSize: z.number().int().min(chunking.structuredMaxChunkSizeMin).max(chunking.structuredMaxChunkSizeMax),
  documentEnrichmentEnabled: z.boolean(),
  manualDocumentEnrichmentOverride: z.enum(manualDocumentEnrichmentOverrides),
} as const;

export const copilotIngestionSettingsChangeSchema = z.object({
  chunkingStrategy: copilotIngestionSettingsFields.chunkingStrategy.optional(),
  fixedWindowChunkSize: copilotIngestionSettingsFields.fixedWindowChunkSize.optional(),
  fixedWindowChunkOverlap: copilotIngestionSettingsFields.fixedWindowChunkOverlap.optional(),
  structuredMinChunkSize: copilotIngestionSettingsFields.structuredMinChunkSize.optional(),
  structuredMaxChunkSize: copilotIngestionSettingsFields.structuredMaxChunkSize.optional(),
  documentEnrichmentEnabled: copilotIngestionSettingsFields.documentEnrichmentEnabled.optional(),
  manualDocumentEnrichmentOverride: copilotIngestionSettingsFields.manualDocumentEnrichmentOverride.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

/**
 * What is stored on the proposal. The write is a whole-object replace, so the payload holds the
 * complete settings the operator would be applying rather than the fields Ray named — a card that
 * showed only the named fields would hide what the rest of the replace carries.
 */
export const copilotIngestionSettingsPayloadSchema = z.object({
  /** Every proposal card reads its target's label from `name`; this target is the workspace's one
   * ingestion settings row, so the label is a constant rather than something Ray chooses. */
  name: z.literal("Ingestion settings"),
  chunkingStrategy: copilotIngestionSettingsFields.chunkingStrategy,
  fixedWindowChunkSize: copilotIngestionSettingsFields.fixedWindowChunkSize,
  fixedWindowChunkOverlap: copilotIngestionSettingsFields.fixedWindowChunkOverlap,
  structuredMinChunkSize: copilotIngestionSettingsFields.structuredMinChunkSize,
  structuredMaxChunkSize: copilotIngestionSettingsFields.structuredMaxChunkSize,
  documentEnrichmentEnabled: copilotIngestionSettingsFields.documentEnrichmentEnabled.optional(),
  manualDocumentEnrichmentOverride: copilotIngestionSettingsFields.manualDocumentEnrichmentOverride.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** Ingestion settings are one row per workspace, and the workspace is already the call's scope. */
export const copilotIngestionSettingsTargetRefSchema = z.object({}).strict();

export type CopilotIngestionSettingsChange = z.infer<typeof copilotIngestionSettingsChangeSchema>;
export type CopilotIngestionSettingsPayload = z.infer<typeof copilotIngestionSettingsPayloadSchema>;

export interface CopilotIngestionSettingsSnapshot {
  readonly chunkingStrategy: string;
  readonly fixedWindowChunkSize: number;
  readonly fixedWindowChunkOverlap: number;
  readonly structuredMinChunkSize: number;
  readonly structuredMaxChunkSize: number;
  readonly documentEnrichmentEnabled?: boolean;
  readonly manualDocumentEnrichmentOverride?: string;
  readonly updatedAt: Date;
}

export interface CopilotIngestionSettingsPort {
  getForWorkspace(workspaceId: string): Promise<CopilotIngestionSettingsSnapshot>;
  updateForWorkspace(workspaceId: string, input: CopilotIngestionSettingsPayload): Promise<unknown>;
}
