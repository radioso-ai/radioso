import type { ClarificationCandidate } from "@radioso/conversation-contract";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { Database } from "../../../shared/infra/database.js";
import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";

export interface RetrievalSensePolicy {
  minGroupShare: number;
  separationThreshold: number;
  maxOptions: number;
}

export interface SenseGroupDocument {
  documentId: string;
  title: string;
  metadata?: Record<string, unknown>;
}

export interface SenseLabelGroup {
  id: string;
  documentIds: string[];
  documents: SenseGroupDocument[];
  share: number;
  separation: number;
}

export interface SenseLabelGateway {
  label(input: {
    groups: SenseLabelGroup[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<Array<{ id: string; label: string; description?: string }>>;
}

export interface SenseEmbeddingReader {
  readChunkEmbeddings(input: {
    workspaceId: string;
    chunkIds: string[];
  }): Promise<Map<string, number[]>>;
}

export const documentScopeFromClarificationCandidate = (
  candidate: ClarificationCandidate,
): string[] | undefined => {
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const documentIds = (payload as { documentIds?: unknown }).documentIds;
  if (!Array.isArray(documentIds) || documentIds.some((id) => typeof id !== "string")) {
    return undefined;
  }
  return [...new Set(documentIds)];
};

export class PostgresSenseEmbeddingReader implements SenseEmbeddingReader {
  constructor(private readonly database: Pick<Database, "query">) {}

  async readChunkEmbeddings(input: { workspaceId: string; chunkIds: string[] }): Promise<Map<string, number[]>> {
    if (input.chunkIds.length === 0) {
      return new Map();
    }
    const rows = await this.database.query<{ id: string; embedding_text: string | null }>(
      `SELECT id, COALESCE(embedding_unbounded::text, embedding::text) AS embedding_text
       FROM chunks
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [input.workspaceId, input.chunkIds],
    );
    return new Map(rows.flatMap((row) => {
      const vector = parsePgVector(row.embedding_text);
      return vector ? [[row.id, vector] as const] : [];
    }));
  }
}

export class ModelSenseLabelGateway implements SenseLabelGateway {
  constructor(
    private readonly inference: ModelInferencePipeline,
    private readonly promptTemplate: string,
  ) {}

  async label(input: {
    groups: SenseLabelGroup[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<Array<{ id: string; label: string; description?: string }>> {
    const { text } = await this.inference.complete({
      operation: input.usageContext ?? {
        workspaceId: "unknown",
        surface: "assistant",
        operation: "clarification",
        attemptKey: "retrieval_sense_labels",
      },
      prompt: renderInjectedPrompt(this.promptTemplate, {
        conversationLanguage: input.conversationLanguage ?? "the conversation language",
        groups: JSON.stringify(input.groups.map((group) => ({
          id: group.id,
          documents: group.documents,
        })), null, 2),
      }),
      maxOutputTokens: 700,
    });
    return parseLabelResponse(text, new Set(input.groups.map((group) => group.id)));
  }
}

export class SenseGroupingService {
  constructor(
    private readonly options: {
      embeddingReader: SenseEmbeddingReader;
      labelGateway: SenseLabelGateway;
      policy: RetrievalSensePolicy;
    },
  ) {}

  async detect(input: {
    workspaceId: string;
    rankedCandidates: RetrievedCandidate[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<ClarificationCandidate[]> {
    const groups = this.qualifyingDocumentGroups(input.rankedCandidates);
    if (groups.length < 2) {
      return [];
    }

    // This service intentionally runs after candidate preparation and before
    // rerank/selection in conversational retrieval. The structural split check is
    // pure arithmetic over already-retrieved candidates; DB embeddings and the
    // single labeling model call happen only for structurally qualified splits.
    const embeddings = await this.options.embeddingReader.readChunkEmbeddings({
      workspaceId: input.workspaceId,
      chunkIds: groups.flatMap((group) => group.chunks.map((chunk) => chunk.chunkId)),
    });
    const separated = groups
      .map((group) => ({
        ...group,
        separation: minimumSeparation(group, groups, embeddings),
      }))
      .filter((group) => group.separation >= this.options.policy.separationThreshold)
      .slice(0, this.options.policy.maxOptions);
    if (separated.length < 2) {
      return [];
    }

    const labelGroups: SenseLabelGroup[] = separated.map((group) => ({
      id: group.documentId,
      documentIds: [group.documentId],
      documents: [{
        documentId: group.documentId,
        title: group.title,
        metadata: group.metadata,
      }],
      share: group.share,
      separation: group.separation,
    }));
    const labels = new Map((await this.options.labelGateway.label({
      groups: labelGroups,
      conversationLanguage: input.conversationLanguage,
      usageContext: input.usageContext,
    })).map((label) => [label.id, label]));

    return labelGroups.map((group) => {
      const label = labels.get(group.id);
      return {
        id: group.id,
        label: label?.label?.trim() || group.documents[0]?.title || group.id,
        ...(label?.description ? { description: label.description } : {}),
        confidence: confidenceFor(group.share, group.separation),
        payload: { documentIds: group.documentIds },
      };
    });
  }

  private qualifyingDocumentGroups(candidates: RetrievedCandidate[]) {
    const total = candidates.length;
    if (total === 0) {
      return [];
    }
    const byDocument = new Map<string, {
      documentId: string;
      title: string;
      metadata?: Record<string, unknown>;
      chunks: RetrievedCandidate[];
      similaritySum: number;
    }>();
    for (const candidate of candidates) {
      const group = byDocument.get(candidate.documentId) ?? {
        documentId: candidate.documentId,
        title: candidate.title,
        metadata: candidate.metadata,
        chunks: [],
        similaritySum: 0,
      };
      group.chunks.push(candidate);
      group.similaritySum += candidate.similarity;
      byDocument.set(candidate.documentId, group);
    }

    return [...byDocument.values()]
      .map((group) => ({
        ...group,
        share: group.chunks.length / total,
        averageSimilarity: group.similaritySum / group.chunks.length,
      }))
      .filter((group) => group.share >= this.options.policy.minGroupShare)
      .sort((left, right) => {
        if (left.share !== right.share) {
          return right.share - left.share;
        }
        if (left.averageSimilarity !== right.averageSimilarity) {
          return right.averageSimilarity - left.averageSimilarity;
        }
        return left.documentId.localeCompare(right.documentId);
      });
  }
}

const parsePgVector = (value: string | null): number[] | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.replace(/^\[/, "").replace(/\]$/, "");
  const numbers = trimmed.split(",").map((part) => Number(part.trim()));
  return numbers.every(Number.isFinite) ? numbers : null;
};

const renderInjectedPrompt = (
  template: string,
  variables: Record<string, string>,
): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => variables[key] ?? "");

const centroid = (vectors: number[][]): number[] | null => {
  const first = vectors[0];
  if (!first) {
    return null;
  }
  const result = new Array(first.length).fill(0);
  for (const vector of vectors) {
    vector.forEach((value, index) => {
      result[index] += value;
    });
  }
  return result.map((value) => value / vectors.length);
};

const distance = (left: number[], right: number[]): number => {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (left[index]! - right[index]!) ** 2;
  }
  return Math.sqrt(sum);
};

const minimumSeparation = (
  group: ReturnType<SenseGroupingService["qualifyingDocumentGroups"]>[number],
  groups: ReturnType<SenseGroupingService["qualifyingDocumentGroups"]>,
  embeddings: Map<string, number[]>,
): number => {
  const groupCentroid = centroid(group.chunks.map((chunk) => embeddings.get(chunk.chunkId)).filter((vector): vector is number[] => !!vector));
  if (!groupCentroid) {
    return 0;
  }
  const distances = groups
    .filter((other) => other.documentId !== group.documentId)
    .map((other) => centroid(other.chunks.map((chunk) => embeddings.get(chunk.chunkId)).filter((vector): vector is number[] => !!vector)))
    .filter((vector): vector is number[] => !!vector)
    .map((otherCentroid) => distance(groupCentroid, otherCentroid));
  return distances.length > 0 ? Math.min(...distances) : 0;
};

const confidenceFor = (share: number, separation: number): number =>
  Math.min(1, Number(((share + Math.min(1, separation)) / 2).toFixed(6)));

const extractJsonArray = (raw: string): string | null => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
};

const parseLabelResponse = (
  raw: string,
  allowedIds: Set<string>,
): Array<{ id: string; label: string; description?: string }> => {
  const json = extractJsonArray(raw);
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as Array<{ id?: unknown; label?: unknown; description?: unknown }>;
    return parsed.flatMap((item) => {
      if (typeof item.id !== "string" || !allowedIds.has(item.id) || typeof item.label !== "string") {
        return [];
      }
      return [{
        id: item.id,
        label: item.label,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }];
    });
  } catch {
    return [];
  }
};
