import type {
  EmbeddingModelId,
  IngestionSettingsRecord,
  ValidatedIngestionSettingsInput,
} from "./ingestion.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "./llmCapability.js";
import type { DeclaredMetadataField, MetadataFieldSuggestion } from "./retrieval.js";
import type { PlatformSettingsResource } from "../domain/platformSettings.js";
import type { OwnerCommitHook } from "../../../shared/infra/kysely/types.js";

export type FieldScopedCasOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "changed"; readonly fields: readonly string[] }
  | { readonly outcome: "targetDeleted" };

export interface IngestionSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  findVersionedByWorkspaceId?(workspaceId: string): Promise<{
    settings: IngestionSettingsRecord;
    revision: string;
  } | null>;
  /**
   * `expectedUpdatedAt` is the version the caller read. Present, it becomes the write's own
   * predicate and a row that moved since is refused with a conflict rather than overwritten by
   * values carried from the older snapshot.
   */
  upsert(
    workspaceId: string,
    input: ValidatedIngestionSettingsInput,
    options?: {
      expectedUpdatedAt?: Date;
    },
  ): Promise<IngestionSettingsRecord>;
  /** Field-scoped proposal CAS: locks the row, compares `expected`/`expectedUpdatedAt`,
   * re-validates the merged state, and writes — all in one transaction. */
  applyProposalPatch(input: {
    readonly workspaceId: string;
    readonly patch: Partial<ValidatedIngestionSettingsInput>;
    /** Runs under the row lock so coupled-field validation sees the current merged state. */
    readonly validateMerged: (current: IngestionSettingsRecord) => ValidatedIngestionSettingsInput;
    readonly onCommitted?: OwnerCommitHook<{ readonly workspaceId: string }>;
  } & (
    | { readonly expected: Partial<ValidatedIngestionSettingsInput> }
    | { readonly expectedUpdatedAt: Date }
  )): Promise<FieldScopedCasOutcome>;
  clearPendingEmbeddingModel?(
    workspaceId: string,
    expectedPendingEmbeddingModel: NonNullable<
      IngestionSettingsRecord["pendingEmbeddingModel"]
    >,
    expectedRevision: string,
  ): Promise<IngestionSettingsRecord | null>;
  promotePendingEmbeddingModelIfReady?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
}

/** The ingestion owner's field-scoped proposal contract: what a copilot draft names and carries. */
export type IngestionSettingsProposalPatch = Partial<Pick<ValidatedIngestionSettingsInput,
  "chunkingStrategy" | "fixedWindowChunkSize" | "fixedWindowChunkOverlap" | "structuredMinChunkSize" | "structuredMaxChunkSize" | "documentEnrichmentEnabled" | "manualDocumentEnrichmentOverride"
>>;
export interface IngestionSettingsFieldProposalPreparation {
  /** Complete, normalized card surface; new proposals write only keys named by `expected`. */
  readonly normalizedPatch: IngestionSettingsProposalPatch;
  readonly expected: IngestionSettingsProposalPatch;
  readonly display: { readonly current: Record<string, unknown>; readonly proposed: Record<string, unknown> };
}
export type IngestionSettingsFieldProposalApplyInput = { readonly normalizedPatch: IngestionSettingsProposalPatch } & (
  | { readonly expected: IngestionSettingsProposalPatch }
  | { readonly expectedUpdatedAt: Date }
);
export type IngestionSettingsFieldProposalApplyOutcome =
  | { readonly status: "applied" }
  | { readonly status: "changed"; readonly fields: readonly string[] }
  | { readonly status: "target_changed" }
  | { readonly status: "target_deleted" };

/** The workspace-settings owner's field-scoped proposal contract: what a copilot draft names and carries. */
export type PlatformSettingsProposalPatch = Partial<Pick<PlatformSettingsResource["assistant"],
  "assistantName" | "greetingInstruction" | "assistantDefaultLocale" | "proactiveGreetingEnabled" | "suggestedQuestionsEnabled" | "customInstruction"
> & Pick<PlatformSettingsResource["channels"],
  "anonymousChatEnabled" | "websiteEmbedEnabled" | "websiteEmbedAllowedOrigins" | "websiteEmbedLauncherLabel" | "websiteEmbedLauncherPosition"
>>;
export interface PlatformSettingsFieldProposalPreparation {
  /** Complete, normalized card surface; only keys in `expected` are written by new proposals. */
  readonly normalizedPatch: PlatformSettingsProposalPatch;
  /** Draft-time values for exactly the fields the proposal changes. */
  readonly expected: PlatformSettingsProposalPatch;
  readonly display: {
    readonly current: Record<string, unknown>;
    readonly proposed: Record<string, unknown>;
    readonly changesReach: boolean;
  };
}
export type PlatformSettingsFieldProposalApplyInput = {
  readonly normalizedPatch: PlatformSettingsProposalPatch;
} & (
  | { readonly expected: PlatformSettingsProposalPatch }
  | { readonly expectedUpdatedAt: Date }
);
export type PlatformSettingsFieldProposalApplyOutcome =
  | { readonly status: "applied"; readonly reason?: string }
  | { readonly status: "changed"; readonly fields: readonly string[] }
  | { readonly status: "target_changed" }
  | { readonly status: "target_deleted" };

export type EmbeddingModelTransitionStatus =
  | "idle"
  | "building"
  | "blocked"
  | "quarantined"
  | "failed"
  | "promoted"
  | "cancelled";

export type EmbeddingModelTransitionReadiness =
  | "building"
  | "ready"
  | "blocked"
  | "unavailable";

export type EmbeddingModelTransitionFailureReason =
  | "validation_failed"
  | "backfill_retry_exhausted"
  | "embedding_contract_drift"
  | "terminal_failure";

/**
 * Settings owns model selection but must not know embedding-space or transition
 * identifiers. Application composition adapts this model-level port to the
 * internal generation-fenced transition coordinator.
 */
export interface EmbeddingModelTransitionState {
  activeModel: string;
  pendingModel: EmbeddingModelId | null;
  status: EmbeddingModelTransitionStatus;
  readiness: EmbeddingModelTransitionReadiness | null;
  failureReason: EmbeddingModelTransitionFailureReason | null;
}

export interface EmbeddingModelTransitionPort {
  getState(workspaceId: string): Promise<EmbeddingModelTransitionState | null>;
  start(input: {
    workspaceId: string;
    activeModel: string;
    targetModel: EmbeddingModelId;
  }): Promise<EmbeddingModelTransitionState>;
  cancel(workspaceId: string): Promise<EmbeddingModelTransitionState>;
  reconcile(workspaceId: string): Promise<EmbeddingModelTransitionState | null>;
}

/**
 * Narrow port for reading/writing the per-workspace LLM capability preferences
 * (chat / rewrite / rerank provider+model). Backed by the same row as retrieval
 * settings, but consumed by a different service so model-selection concerns do
 * not leak into retrieval-pipeline configuration.
 */
export interface WorkspaceLlmCapabilityPreferencesRepositoryPort {
  ensureRow(workspaceId: string): Promise<void>;
  findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]>;
  setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void>;
}

export interface RetrievalMetadataFieldSourcePort {
  listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]>;
}

/**
 * Field keys some document type declares, with the value type extraction will
 * write them under. Read from the document type catalog without scanning
 * document metadata.
 */
export interface DeclaredMetadataFieldSourcePort {
  listDeclaredMetadataFields(workspaceId: string): Promise<readonly DeclaredMetadataField[]>;
}
