import type { ClarificationCandidate } from "@radioso/conversation-contract";
import { sql } from "kysely";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
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

/**
 * `relationship` is an LLM-returned judgment (never an in-code keyword test): are
 * the candidate groups mutually exclusive readings of the question, or complementary
 * facets of a single intent that one combined answer should cover? Absent/unparsed
 * ⇒ treated as exclusive (conservative, preserves prior behavior).
 */
export type SenseRelationship = "exclusive" | "complementary";

export interface SenseLabelGateway {
  label(input: {
    question: string;
    groups: SenseLabelGroup[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<Array<{ id: string; label: string; description?: string; relationship?: SenseRelationship }>>;
}

export type RetrievalSenseClarificationCandidate = ClarificationCandidate & {
  labelStatus: "generated" | "missing";
  /** Set only when the gateway judges the whole candidate set complementary facets. */
  relationship?: SenseRelationship;
};

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
  constructor(private readonly db: Db) {}

  async readChunkEmbeddings(input: { workspaceId: string; chunkIds: string[] }): Promise<Map<string, number[]>> {
    if (input.chunkIds.length === 0) {
      return new Map();
    }
    // pgvector columns serialize to text for in-process distance math; the cast is a
    // Postgres-specific fragment the builder can't express. `parsePgVector` maps the
    // `[a,b,...]` literal back to numbers, unchanged from the raw-SQL behaviour.
    const rows = await this.db
      .selectFrom("chunks")
      .select([
        "id",
        sql<string | null>`coalesce(embedding_unbounded::text, embedding::text)`.as("embedding_text"),
      ])
      .where("workspace_id", "=", input.workspaceId)
      .where((eb) => anyOf(eb.ref("id"), input.chunkIds, "uuid[]"))
      .execute();
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
    question: string;
    groups: SenseLabelGroup[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<Array<{ id: string; label: string; description?: string; relationship?: SenseRelationship }>> {
    const { text } = await this.inference.complete({
      operation: input.usageContext ?? {
        workspaceId: "unknown",
        surface: "assistant",
        operation: "clarification",
        attemptKey: "retrieval_sense_labels",
      },
      prompt: renderInjectedPrompt(this.promptTemplate, {
        question: input.question,
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
    question: string;
    rankedCandidates: RetrievedCandidate[];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<RetrievalSenseClarificationCandidate[]> {
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
    const bestAverageSimilarity = Math.max(...separated.map((group) => group.averageSimilarity));
    const labelResults = await this.options.labelGateway.label({
      question: input.question,
      groups: labelGroups,
      conversationLanguage: input.conversationLanguage,
      usageContext: input.usageContext,
    }).catch(() => []);
    const labels = new Map(labelResults.map((label) => [label.id, label]));
    // The relationship is a single set-level judgment; treat the set as
    // complementary only when *every separated group* carries a parsed
    // complementary label. Checking the deduped map per group closes the
    // partial-labeling gap: a dropped or duplicated label (invalid id, non-string
    // label, omitted group) must not let an unlabeled — potentially exclusive —
    // facet ride along as complementary. Any exclusive, missing, or unparsed value
    // falls back to exclusive.
    const complementary = separated.every(
      (group) => labels.get(group.documentId)?.relationship === "complementary",
    );

    return separated.map((group) => {
      const label = labels.get(group.documentId);
      const generatedLabel = label?.label?.trim();
      return {
        id: group.documentId,
        // A labeling miss must never leak the document id/title to the visitor; keep
        // the id internally (payload) and represent the missing label honestly.
        label: generatedLabel || "",
        labelStatus: generatedLabel ? "generated" : "missing",
        ...(label?.description ? { description: label.description } : {}),
        ...(complementary ? { relationship: "complementary" as const } : {}),
        confidence: confidenceFor(group.share, group.separation, group.averageSimilarity, bestAverageSimilarity),
        payload: { documentIds: [group.documentId] },
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

const confidenceFor = (
  share: number,
  separation: number,
  averageSimilarity: number,
  bestAverageSimilarity: number,
): number => {
  const structuralConfidence = (share + Math.min(1, separation)) / 2;
  const relevanceConfidence = bestAverageSimilarity > 0
    ? Math.max(0, Math.min(1, averageSimilarity / bestAverageSimilarity))
    : 1;
  return Math.min(1, Number(((structuralConfidence + relevanceConfidence) / 2).toFixed(6)));
};

const extractJsonArray = (raw: string): string | null => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
};

const parseRelationship = (value: unknown): SenseRelationship | undefined =>
  value === "exclusive" || value === "complementary" ? value : undefined;

const parseLabelResponse = (
  raw: string,
  allowedIds: Set<string>,
): Array<{ id: string; label: string; description?: string; relationship?: SenseRelationship }> => {
  const json = extractJsonArray(raw);
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as Array<{ id?: unknown; label?: unknown; description?: unknown; relationship?: unknown }>;
    return parsed.flatMap((item) => {
      if (typeof item.id !== "string" || !allowedIds.has(item.id) || typeof item.label !== "string") {
        return [];
      }
      const relationship = parseRelationship(item.relationship);
      return [{
        id: item.id,
        label: item.label,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(relationship ? { relationship } : {}),
      }];
    });
  } catch {
    return [];
  }
};
