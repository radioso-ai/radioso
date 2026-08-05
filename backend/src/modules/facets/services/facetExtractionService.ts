import type { ClusteringEmbeddingPort } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type {
  FacetExtractionInferenceFactory,
  FacetExtractionJob,
  FacetExtractionOutcome,
  FacetExtractionPort,
  FacetSourceMessagePort,
  MessageFacetRepositoryPort,
} from "../contracts.js";
import {
  FACET_EXTRACTION_MAX_INPUT_TOKENS,
  FACET_EXTRACTION_MAX_OUTPUT_TOKENS,
  FACET_EXTRACTION_PROMPT_VERSION,
  FACET_EXTRACTION_RESPONSE_FORMAT,
  buildFacetExtractionPrompt,
  parseFacetExtractionModelOutput,
} from "./prompt.js";

export interface FacetExtractionServiceDependencies {
  messages: FacetSourceMessagePort;
  facets: MessageFacetRepositoryPort;
  embeddings: ClusteringEmbeddingPort;
  inferenceFactory: FacetExtractionInferenceFactory;
  /** Overridable for tests; defaults to the shipped recipe version. */
  promptVersion?: string;
}

const modelCallContextFor = (job: FacetExtractionJob): ModelCallUsageContext => ({
  workspaceId: job.workspaceId,
  messageId: job.messageId,
  surface: "facet_extraction",
  operation: "extraction",
  attemptKey: `facet-extraction:${job.id}:${job.attemptCount}`,
});

const embeddingCallContextFor = (job: FacetExtractionJob): ModelCallUsageContext => ({
  workspaceId: job.workspaceId,
  messageId: job.messageId,
  surface: "facet_extraction",
  operation: "embedding",
  attemptKey: `facet-embedding:${job.id}:${job.attemptCount}`,
});

/**
 * Turns one queued message into a stored, embedded facet.
 *
 * Extraction and embedding are separate persisted steps on purpose: the facet is
 * upserted as soon as the model returns it, and only then does embedding run. A job
 * reclaimed after an embedding failure finds its facet already at the current prompt
 * version and skips straight to re-embedding, so a transient embedding outage never
 * pays for the model call twice.
 */
export class FacetExtractionService implements FacetExtractionPort {
  constructor(private readonly deps: FacetExtractionServiceDependencies) {}

  async extract(job: FacetExtractionJob): Promise<FacetExtractionOutcome> {
    const promptVersion = this.deps.promptVersion ?? FACET_EXTRACTION_PROMPT_VERSION;
    const existing = await this.loadExistingFacet(job, promptVersion);

    let facetText: string;
    if (existing) {
      facetText = existing.facetText;
    } else {
      const question = await this.deps.messages.getContentById({
        workspaceId: job.workspaceId,
        messageId: job.messageId,
      });
      if (question === null) {
        return { status: "skipped", reason: "message_not_found" };
      }
      const trimmedQuestion = question.trim();
      if (trimmedQuestion.length === 0) {
        return { status: "skipped", reason: "empty_message" };
      }

      const extracted = await this.callModel(trimmedQuestion, job);
      if (extracted.length === 0) {
        return { status: "skipped", reason: "empty_facet" };
      }

      facetText = extracted;
      await this.deps.facets.upsertFacet({
        messageId: job.messageId,
        workspaceId: job.workspaceId,
        facetText,
        promptVersion,
      });
    }

    await this.embedAndAttach(job, facetText);
    return { status: "extracted" };
  }

  private async loadExistingFacet(job: FacetExtractionJob, promptVersion: string) {
    const [record] = await this.deps.facets.listForWindow({
      workspaceId: job.workspaceId,
      messageIds: [job.messageId],
    });
    return record && record.promptVersion === promptVersion ? record : undefined;
  }

  private async callModel(question: string, job: FacetExtractionJob): Promise<string> {
    const modelCallContext = modelCallContextFor(job);
    const inference = await this.deps.inferenceFactory.create({
      workspaceContext: { workspaceId: job.workspaceId },
      modelCallContext,
    });
    const completion = await inference.complete({
      prompt: buildFacetExtractionPrompt(question),
      maxInputTokens: FACET_EXTRACTION_MAX_INPUT_TOKENS,
      maxOutputTokens: FACET_EXTRACTION_MAX_OUTPUT_TOKENS,
      responseFormat: FACET_EXTRACTION_RESPONSE_FORMAT,
      operation: modelCallContext,
      validateResult(result) {
        parseFacetExtractionModelOutput(result.text);
      },
    });
    return parseFacetExtractionModelOutput(completion.text).facet;
  }

  private async embedAndAttach(job: FacetExtractionJob, facetText: string): Promise<void> {
    const embedded = await this.deps.embeddings.embedForClustering({
      workspaceId: job.workspaceId,
      texts: [facetText],
      usageContext: embeddingCallContextFor(job),
    });
    const vector = embedded.vectors[0];
    if (!vector || !embedded.space) {
      throw new Error("Clustering embedding returned no vector for the facet");
    }
    await this.deps.facets.attachEmbedding({
      messageId: job.messageId,
      embedding: [...vector],
      embeddingProfileId: embedded.space.id,
    });
  }
}
