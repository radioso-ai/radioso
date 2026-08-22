import { ZodError } from "zod";

import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
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
import { stripBuiltInTemporalTags } from "../domain/enrichment/generatedTagOwnership.js";
import type { EnrichableChunk } from "../domain/enrichment/chunkMetadataPatches.js";

export interface DocumentEnrichmentGateway {
  generate(input: {
    workspaceId: string;
    documentId: string;
    documentRevision: number;
    prompt: string;
    documentRepresentation: string;
  }): Promise<{ model: string; output: unknown }>;
}

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
}

export interface DocumentEnrichmentStageResult<TChunk extends EnrichableChunk = EnrichableChunk> {
  status: "applied" | "failed";
  // Flat user-facing tags only; provenance travels separately because document
  // metadata is a flat scalar contract owned by the caller.
  documentMetadata: Record<string, unknown>;
  provenance: DocumentEnrichmentProvenance;
  chunks: TChunk[];
  factCount: number;
  appliedChunkCount: number;
}

export interface DocumentEnrichmentStagePort {
  enrich<TChunk extends EnrichableChunk>(
    input: DocumentEnrichmentStageInput<TChunk>,
  ): Promise<DocumentEnrichmentStageResult<TChunk>>;
}

export class ModelDocumentEnrichmentGateway implements DocumentEnrichmentGateway {
  constructor(private readonly pipeline: ModelInferencePipeline) {}

  async generate(input: {
    workspaceId: string;
    documentId: string;
    documentRevision: number;
    prompt: string;
    documentRepresentation: string;
  }): Promise<{ model: string; output: unknown }> {
    const result = await this.pipeline.complete({
      prompt: input.documentRepresentation,
      systemPrompt: input.prompt,
      temperature: 0,
      reasoningEffort: "low",
      maxOutputTokens: 2_000,
      operation: {
        workspaceId: input.workspaceId,
        requestId: input.documentId,
        surface: "documents",
        operation: "document_enrichment",
        attemptKey: `document-enrichment:${input.documentId}:${input.documentRevision}`,
      },
    });

    return {
      model: this.pipeline.metadata.model,
      output: JSON.parse(stripJsonFence(result.text)) as unknown,
    };
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
    const previousGeneratedKeys = input.previousProvenance?.generatedKeys ?? [];

    try {
      const prompt = buildDocumentEnrichmentPrompt({ template: this.prompt, types: catalog.types });
      const representation = buildBoundedDocumentRepresentation(input.document);
      const gatewayResult = await this.deps.gateway.generate({
        workspaceId: input.document.workspaceId,
        documentId: input.document.id,
        documentRevision: input.document.revision,
        prompt,
        documentRepresentation: representation.text,
      });
      const parsed = validateOutputForDocument(
        normalizeRepresentationRanges(
          parseDocumentEnrichmentOutput(gatewayResult.output),
          representation.bodyOffset,
        ),
        representation.bodyLength,
      );
      const shape = normalizeDocumentShape(parsed.shape, parsed.confidence);
      const matched = resolveMatchedDocumentType({
        types: catalog.types,
        typeKey: parsed.typeKey,
        confidence: parsed.confidence,
      });

      // Stage 2 runs against the matched type's declarations only; a
      // classification-only or built-in type declares no `fields` payload, so
      // every entry the model volunteered is dropped as undeclared.
      const declaredFields = matched.type?.payload === "fields" ? matched.type.fields : [];
      const validated = validateExtractedFields({ entries: parsed.fields, declaredFields });

      // Cleanup is atomic with success: the previous run's keys come off here,
      // and what remains under a generated key's name is manually owned.
      const applied = applyExtractedFields({
        documentMetadata: stripBuiltInTemporalTags(input.document.metadata, Boolean(input.previousProvenance)),
        chunks: input.chunks,
        fields: validated.fields,
        previousGeneratedKeys,
      });

      const strategyResult = this.strategyRegistry.get(shape).apply({
        documentMetadata: applied.documentMetadata,
        chunks: applied.chunks,
        facts: parsed.facts,
      });

      const fieldCounts = {
        applied: applied.generatedKeys.length,
        ...validated.counts,
        skippedCollision: applied.skippedCollision,
      };
      const reportsFields =
        declaredFields.length > 0 || Object.values(fieldCounts).some((count) => count > 0);
      const appliedChunkCount = Math.max(strategyResult.appliedChunkCount, applied.appliedChunkCount);

      const provenance = buildProvenance({
        status: "applied",
        shape,
        model: gatewayResult.model,
        enrichedAt: this.now().toISOString(),
        anchorDate: input.anchor.date,
        anchorSource: input.anchor.source,
        factCount: parsed.facts.length,
        appliedChunkCount,
        matchedTypeKey: matched.key,
        catalogRevision: catalog.revision,
        generatedKeys: applied.generatedKeys,
        fieldCounts: reportsFields ? fieldCounts : null,
        classificationNote: matched.note,
      });

      return {
        status: "applied",
        documentMetadata: strategyResult.documentMetadata,
        provenance,
        chunks: strategyResult.chunks,
        factCount: parsed.facts.length,
        appliedChunkCount,
      };
    } catch (error) {
      // A failed run touches nothing but its own failure fields: tags, the
      // generated-key set, and the last successful run's catalog revision all
      // survive for the next attempt to clean up.
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
        appliedChunkCount: 0,
      };
    }
  }
}

const preservedProvenanceFields = (
  previous: DocumentEnrichmentProvenance | null | undefined,
): Partial<DocumentEnrichmentProvenance> =>
  previous
    ? {
        shape: previous.shape,
        model: previous.model,
        matchedTypeKey: previous.matchedTypeKey,
        catalogRevision: previous.catalogRevision,
        generatedKeys: previous.generatedKeys,
        fieldCounts: previous.fieldCounts,
        classificationNote: previous.classificationNote,
      }
    : {};

// Failure reasons stay content-free: zod issue paths and error names only,
// never model output or document text.
const describeEnrichmentFailure = (error: unknown): string => {
  if (error instanceof ZodError) {
    const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 5);
    return `invalid_output: ${paths.join(", ")}`;
  }
  if (error instanceof SyntaxError) {
    return "invalid_output: not_json";
  }
  if (error instanceof Error && error.message === "enrichment_fact_range_out_of_bounds") {
    return "invalid_output: fact_range_out_of_bounds";
  }
  if (error instanceof Error && error.message === ENRICHMENT_CATALOG_OVER_BUDGET) {
    return "catalog_over_budget";
  }
  return "provider_error";
};

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

const MAX_DOCUMENT_REPRESENTATION_CHARS = 48_000;

const buildBoundedDocumentRepresentation = (document: {
  title: string;
  markdownContent: string;
  createdAt: Date;
}): { text: string; bodyOffset: number; bodyLength: number } => {
  const body = document.markdownContent.slice(0, MAX_DOCUMENT_REPRESENTATION_CHARS);
  const prefix = [
    `Title: ${document.title}`,
    `Created at: ${document.createdAt.toISOString()}`,
    "",
    "",
  ].join("\n");
  return {
    text: `${prefix}${body}`,
    bodyOffset: prefix.length,
    bodyLength: body.length,
  };
};

const normalizeRepresentationRanges = (
  output: DocumentEnrichmentOutput,
  bodyOffset: number,
): DocumentEnrichmentOutput => ({
  ...output,
  facts: output.facts.map((fact) => ({
    ...fact,
    sourceRange: toBodySourceRange(fact.sourceRange, bodyOffset),
  })),
});

const toBodySourceRange = (
  sourceRange: TemporalFact["sourceRange"],
  bodyOffset: number,
): TemporalFact["sourceRange"] => ({
  start: sourceRange.start - bodyOffset,
  end: sourceRange.end - bodyOffset,
});

const validateOutputForDocument = (
  output: DocumentEnrichmentOutput,
  documentLength: number,
): DocumentEnrichmentOutput => {
  for (const fact of output.facts) {
    if (fact.sourceRange.start < 0 || fact.sourceRange.end > documentLength) {
      throw new Error("enrichment_fact_range_out_of_bounds");
    }
  }
  return output;
};

const buildProvenance = (input: DocumentEnrichmentProvenance): DocumentEnrichmentProvenance => ({
  status: input.status,
  shape: input.shape,
  model: input.model ?? null,
  enrichedAt: input.enrichedAt ?? null,
  anchorDate: input.anchorDate ?? null,
  anchorSource: input.anchorSource ?? null,
  factCount: input.factCount ?? 0,
  appliedChunkCount: input.appliedChunkCount ?? 0,
  failureReason: input.failureReason ?? null,
  matchedTypeKey: input.matchedTypeKey ?? null,
  catalogRevision: input.catalogRevision ?? null,
  generatedKeys: input.generatedKeys ?? [],
  fieldCounts: input.fieldCounts ?? null,
  classificationNote: input.classificationNote ?? null,
});
