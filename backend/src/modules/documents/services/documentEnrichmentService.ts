import { ZodError } from "zod";

import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { EnabledDocumentTypesSnapshot } from "../../documentTypes/public.js";
import {
  parseDocumentEnrichmentOutput,
  normalizeDocumentShape,
  type DocumentEnrichmentOutput,
  type DocumentEnrichmentProvenance,
  type EnrichmentAnchorSource,
  type TemporalFact,
} from "../domain/enrichment/documentEnrichmentContract.js";
import {
  EnrichmentReplyUnreadableError,
  type DocumentEnrichmentGateway,
  type DocumentEnrichmentRequest,
  type EnrichmentRetryCause,
} from "../domain/enrichment/enrichmentGateway.js";
import { buildDocumentEnrichmentOutputSchema } from "../domain/enrichment/enrichmentOutputSchema.js";
import { locateQuotedFacts } from "../domain/enrichment/factQuoteLocation.js";
import {
  createDefaultDocumentEnrichmentStrategyRegistry,
  type DocumentEnrichmentStrategyRegistry,
} from "../domain/enrichment/enrichmentStrategies.js";
import {
  defaultEnabledDocumentTypes,
  resolveMatchedDocumentType,
} from "../domain/enrichment/documentTypeMatch.js";
import {
  ENRICHMENT_CATALOG_OVER_BUDGET,
  buildDocumentEnrichmentPrompt,
} from "../domain/enrichment/enrichmentPromptBuilder.js";
import {
  applyExtractedFields,
  validateExtractedFields,
} from "../domain/enrichment/extractedFields.js";
import {
  applyTemporalTagsWithOwnership,
  resolveExtractionOwnedKeys,
  sourceSyncsDocumentDates,
  stripLegacyProvenanceTag,
} from "../domain/enrichment/generatedTagOwnership.js";
import type { EnrichableChunk } from "../domain/enrichment/chunkMetadataPatches.js";

export interface DocumentEnrichmentStageInput<TChunk extends EnrichableChunk = EnrichableChunk> {
  document: {
    id: string;
    workspaceId: string;
    revision: number;
    title: string;
    markdownContent: string;
    metadata: Record<string, unknown>;
    createdAt: Date;
  };
  chunks: TChunk[];
  anchor: {
    source: EnrichmentAnchorSource;
    date: string;
  };
  /**
   * The enabled catalog, resolved at execution time. Omitted means the default
   * catalog: the built-in entries at their shipped defaults.
   */
  catalog?: EnabledDocumentTypesSnapshot;
  /**
   * Provenance of the run that produced the document's current tags. It carries
   * the generated-key set this run owns and replaces, and the state a failed
   * run preserves.
   */
  previousProvenance?: DocumentEnrichmentProvenance | null;
  /**
   * The document's source: its kind and the tags it stamps on every chunk.
   * Extraction never removes or overwrites those tags, and dates among them
   * keep the run from writing any date. The kind decides whether dates on the
   * document itself are a syncing connector's defaults the run may replace.
   */
  source?: { kind: string; documentMetadata: Record<string, unknown> } | null;
}

export interface DocumentEnrichmentStageResult<TChunk extends EnrichableChunk = EnrichableChunk> {
  status: "applied" | "failed";
  // Flat user-facing tags only; provenance travels separately because document
  // metadata is a flat scalar contract owned by the caller.
  documentMetadata: Record<string, unknown>;
  provenance: DocumentEnrichmentProvenance;
  chunks: TChunk[];
  factCount: number;
  /** Facts the reply carried that the run could not use: invalid, or quoting text the document lacks. */
  droppedFactCount: number;
  appliedChunkCount: number;
  /** Model requests the run made: 0 when it failed before asking, 2 after a retry. */
  modelAttemptCount: number;
  /** Content-free reason the first request's reply was unusable, when the run asked again. */
  firstAttemptFailureReason: string | null;
}

export interface DocumentEnrichmentStagePort {
  enrich<TChunk extends EnrichableChunk>(
    input: DocumentEnrichmentStageInput<TChunk>,
  ): Promise<DocumentEnrichmentStageResult<TChunk>>;
}

type EnrichmentRequestInput = Omit<DocumentEnrichmentRequest, "retry">;

/** The model requests one run made, and why the first was unusable when there was a second. */
interface ModelAttempts {
  count: number;
  firstFailureReason: string | null;
}

/** A reply read and placed against the document: what the run applies. */
interface UsableReply {
  model: string;
  parsed: DocumentEnrichmentOutput;
  facts: TemporalFact[];
  droppedFactCount: number;
  matched: ReturnType<typeof resolveMatchedDocumentType>;
}

/**
 * A reply for a dated type whose every fact was invalid or unplaceable.
 * Applying it would remove the previous run's dates and write none, so it is
 * as unusable as a reply that is not JSON. Content-free by construction.
 */
class NoUsableFactsError extends Error {
  constructor() {
    super("enrichment_no_usable_facts");
    this.name = "NoUsableFactsError";
  }
}

export class DocumentEnrichmentService implements DocumentEnrichmentStagePort {
  private readonly prompt: string;
  private readonly strategyRegistry: DocumentEnrichmentStrategyRegistry;
  private readonly now: () => Date;

  constructor(private readonly deps: {
    gateway: DocumentEnrichmentGateway;
    strategyRegistry?: DocumentEnrichmentStrategyRegistry;
    prompt?: string;
    now?: () => Date;
  }) {
    this.prompt = deps.prompt ?? loadPromptTemplate("ingestion/document-enrichment.md");
    this.strategyRegistry = deps.strategyRegistry ?? createDefaultDocumentEnrichmentStrategyRegistry();
    this.now = deps.now ?? (() => new Date());
  }

  async enrich<TChunk extends EnrichableChunk>(
    input: DocumentEnrichmentStageInput<TChunk>,
  ): Promise<DocumentEnrichmentStageResult<TChunk>> {
    const catalog = input.catalog ?? defaultEnabledDocumentTypes();
    const attempts: ModelAttempts = { count: 0, firstFailureReason: null };

    try {
      const prompt = buildDocumentEnrichmentPrompt({ template: this.prompt, types: catalog.types });
      const representation = buildBoundedDocumentRepresentation(input.document);
      const reply = await this.requestUsableReply({
        workspaceId: input.document.workspaceId,
        documentId: input.document.id,
        documentRevision: input.document.revision,
        prompt,
        documentRepresentation: representation.text,
        outputSchema: buildDocumentEnrichmentOutputSchema(catalog.types),
      }, attempts, (model, output) => readUsableReply({
        model,
        output,
        types: catalog.types,
        body: representation.body,
        title: input.document.title,
      }));
      const { parsed, matched, droppedFactCount } = reply;
      const shape = normalizeDocumentShape(parsed.shape, parsed.confidence);

      // Stage 2 runs against the matched type's declarations only; a
      // classification-only or built-in type declares no `fields` payload, so
      // every entry the model volunteered is dropped as undeclared.
      const declaredFields = matched.type?.payload === "fields" ? matched.type.fields : [];
      const validated = validateExtractedFields({ entries: parsed.fields, declaredFields });

      // Cleanup is atomic with success: every key the previous run owned —
      // dates included — comes off here, and what remains under a generated
      // key's name is manually owned.
      const applied = applyExtractedFields({
        documentMetadata: stripLegacyProvenanceTag(input.document.metadata, Boolean(input.previousProvenance)),
        chunks: input.chunks,
        fields: validated.fields,
        previousGeneratedKeys: resolveExtractionOwnedKeys(input.previousProvenance),
        sourceMetadata: input.source?.documentMetadata,
      });

      // Temporal strategies run only when the catalog matched that built-in;
      // a fallback (disabled or unknown type) must not write date tags even if
      // the model volunteered facts.
      const strategyShape = matched.type?.payload === "facts" ? normalizeDocumentShape(matched.key, parsed.confidence) : "generic";
      const strategyResult = applyTemporalTagsWithOwnership(
        this.strategyRegistry.get(strategyShape),
        {
          documentMetadata: applied.documentMetadata,
          chunks: applied.chunks,
          facts: reply.facts,
          droppedFactCount,
        },
        {
          sourceMetadata: input.source?.documentMetadata,
          documentDatesAreSyncDefaults: sourceSyncsDocumentDates(input.source?.kind),
        },
      );

      const fieldCounts = {
        applied: applied.generatedKeys.length,
        ...validated.counts,
        skippedCollision: applied.skippedCollision + strategyResult.skippedCollision,
      };
      const reportsFields =
        declaredFields.length > 0 || Object.values(fieldCounts).some((count) => count > 0);
      const appliedChunkCount = Math.max(strategyResult.appliedChunkCount, applied.appliedChunkCount);

      const provenance = buildProvenance({
        status: "applied",
        shape,
        model: reply.model,
        enrichedAt: this.now().toISOString(),
        anchorDate: input.anchor.date,
        anchorSource: input.anchor.source,
        factCount: reply.facts.length,
        droppedFactCount,
        appliedChunkCount,
        matchedTypeKey: matched.key,
        catalogRevision: catalog.revision,
        generatedKeys: [...applied.generatedKeys, ...strategyResult.generatedKeys],
        fieldCounts: reportsFields ? fieldCounts : null,
        classificationNote: matched.note,
      });

      return {
        status: "applied",
        documentMetadata: strategyResult.documentMetadata,
        provenance,
        chunks: strategyResult.chunks,
        factCount: reply.facts.length,
        droppedFactCount,
        appliedChunkCount,
        modelAttemptCount: attempts.count,
        firstAttemptFailureReason: attempts.firstFailureReason,
      };
    } catch (error) {
      // A failed run touches nothing but its own failure fields: tags, the
      // keys extraction owns, and the last successful run's catalog revision
      // all survive for the next attempt to clean up.
      return {
        status: "failed",
        documentMetadata: input.document.metadata,
        provenance: buildProvenance({
          ...preservedProvenanceFields(input.previousProvenance),
          status: "failed",
          enrichedAt: this.now().toISOString(),
          anchorDate: input.anchor.date,
          anchorSource: input.anchor.source,
          factCount: 0,
          appliedChunkCount: 0,
          failureReason: describeEnrichmentFailure(error),
        }),
        chunks: input.chunks,
        factCount: 0,
        droppedFactCount: 0,
        appliedChunkCount: 0,
        modelAttemptCount: attempts.count,
        firstAttemptFailureReason: attempts.firstFailureReason,
      };
    }
  }

  /**
   * One request, and one more when its reply cannot be used. Provider errors
   * are not asked again here: the adapters retry transient ones themselves.
   */
  private async requestUsableReply(
    request: EnrichmentRequestInput,
    attempts: ModelAttempts,
    read: (model: string, output: unknown) => UsableReply,
  ): Promise<UsableReply> {
    try {
      return await this.ask(request, attempts, read);
    } catch (error) {
      const after = retryCauseOf(error);
      if (!after) {
        throw error;
      }
      attempts.firstFailureReason = describeEnrichmentFailure(error);
      return this.ask({ ...request, retry: { after } }, attempts, read);
    }
  }

  private async ask(
    request: DocumentEnrichmentRequest,
    attempts: ModelAttempts,
    read: (model: string, output: unknown) => UsableReply,
  ): Promise<UsableReply> {
    attempts.count += 1;
    const reply = await this.deps.gateway.generate(request);
    return read(reply.model, reply.output);
  }
}

/** Parses a reply and places its facts; throws when the reply is unusable. */
const readUsableReply = (input: {
  model: string;
  output: unknown;
  types: EnabledDocumentTypesSnapshot["types"];
  body: string;
  title: string;
}): UsableReply => {
  const parsed = parseDocumentEnrichmentOutput(input.output);
  const located = locateQuotedFacts({ facts: parsed.facts, body: input.body, title: input.title });
  const matched = resolveMatchedDocumentType({ types: input.types, typeKey: parsed.typeKey, confidence: parsed.confidence });
  const droppedFactCount = parsed.invalidFactCount + located.unplacedCount;
  // Only a dated type writes dates, so only its facts can cost the document
  // anything; a stray fact on any other type is dropped and counted.
  if (matched.type?.payload === "facts" && droppedFactCount > 0 && located.facts.length === 0) {
    throw new NoUsableFactsError();
  }
  return { model: input.model, parsed, facts: located.facts, droppedFactCount, matched };
};

// A reply that does not match the envelope schema, or whose facts are all
// unusable, is as unreadable as one that is not JSON: the next sample may well
// be readable.
const retryCauseOf = (error: unknown): EnrichmentRetryCause | null => {
  if (error instanceof EnrichmentReplyUnreadableError) {
    return error.reason === "truncated" ? "truncated" : "unreadable";
  }
  if (error instanceof ZodError || error instanceof NoUsableFactsError) {
    return "unreadable";
  }
  return null;
};

const preservedProvenanceFields = (
  previous: DocumentEnrichmentProvenance | null | undefined,
): Partial<DocumentEnrichmentProvenance> =>
  previous
    ? {
        shape: previous.shape,
        model: previous.model,
        matchedTypeKey: previous.matchedTypeKey,
        catalogRevision: previous.catalogRevision,
        // Recorded explicitly: the failure's own status would otherwise hide
        // date ownership that the previous run's provenance only implied.
        generatedKeys: resolveExtractionOwnedKeys(previous),
        fieldCounts: previous.fieldCounts,
        classificationNote: previous.classificationNote,
      }
    : {};

// Failure reasons stay content-free: zod issue paths and named reasons only,
// never model output or document text.
const describeEnrichmentFailure = (error: unknown): string => {
  if (error instanceof ZodError) {
    const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 5);
    return `invalid_output: ${paths.join(", ")}`;
  }
  if (error instanceof EnrichmentReplyUnreadableError) {
    return `invalid_output: ${error.reason}`;
  }
  if (error instanceof NoUsableFactsError) {
    return "invalid_output: no_usable_facts";
  }
  if (error instanceof Error && error.message === ENRICHMENT_CATALOG_OVER_BUDGET) {
    return "catalog_over_budget";
  }
  return "provider_error";
};

const MAX_DOCUMENT_REPRESENTATION_CHARS = 48_000;

const buildBoundedDocumentRepresentation = (document: {
  title: string;
  markdownContent: string;
  createdAt: Date;
}): { text: string; body: string } => {
  const body = document.markdownContent.slice(0, MAX_DOCUMENT_REPRESENTATION_CHARS);
  const prefix = [
    `Title: ${document.title}`,
    `Created at: ${document.createdAt.toISOString()}`,
    "",
    "",
  ].join("\n");
  return { text: `${prefix}${body}`, body };
};

const buildProvenance = (input: DocumentEnrichmentProvenance): DocumentEnrichmentProvenance => ({
  status: input.status,
  shape: input.shape,
  model: input.model ?? null,
  enrichedAt: input.enrichedAt ?? null,
  anchorDate: input.anchorDate ?? null,
  anchorSource: input.anchorSource ?? null,
  factCount: input.factCount ?? 0,
  droppedFactCount: input.droppedFactCount ?? 0,
  appliedChunkCount: input.appliedChunkCount ?? 0,
  failureReason: input.failureReason ?? null,
  matchedTypeKey: input.matchedTypeKey ?? null,
  catalogRevision: input.catalogRevision ?? null,
  generatedKeys: input.generatedKeys ?? [],
  dateOwnershipRecorded: true,
  fieldCounts: input.fieldCounts ?? null,
  classificationNote: input.classificationNote ?? null,
});
