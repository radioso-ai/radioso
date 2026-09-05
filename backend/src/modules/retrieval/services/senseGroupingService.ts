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
  /**
   * Short passages of the group's own retrieved chunks, supplied solely as
   * evidence for the `relationship` judgment. Titles and metadata cannot reveal
   * that two documents *state the same content* — a live page and a leftover
   * draft of it read as unrelated by title alone — so the judgment is blind
   * without them. Labels and descriptions are never derived from this text.
   */
  excerpts?: string[];
  share: number;
  separation: number;
}

/**
 * Excerpt budget. Two passages per group is enough for the model to recognise
 * restated content, and capping each keeps the labeling prompt bounded when a
 * group's chunks are large.
 */
const EXCERPTS_PER_GROUP = 2;
const EXCERPT_MAX_CHARS = 320;

/**
 * `relationship` is an LLM-returned judgment (never an in-code keyword test) of how
 * the candidate groups relate to the visitor's question:
 * - `exclusive` — mutually exclusive readings; worth asking which one is meant.
 * - `complementary` — different facets of one intent that a single combined answer
 *   should cover.
 * - `redundant` — near-duplicate or versioned copies of the same content (for
 *   example a live page and a leftover draft of it); answering from all of them is
 *   correct and clarifying is pointless.
 * Absent/unparsed ⇒ treated as exclusive (conservative, preserves prior behavior).
 */
export type SenseRelationship = "exclusive" | "complementary" | "redundant";

/** Relationship values that never warrant a clarifying question. */
const NON_EXCLUSIVE_RELATIONSHIPS: ReadonlySet<SenseRelationship> = new Set(["complementary", "redundant"]);

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
    // Cosine distance only has meaning inside one embedding space. The canonical
    // query is pinned to the active space and current document revision, so an
    // incomplete result deliberately disables grouping rather than mixing vectors.
    const canonical = await this.readCanonicalEmbeddings(input);
    return canonical.size === new Set(input.chunkIds).size ? canonical : new Map();
  }

  /**
   * Vectors from `chunk_embeddings`, pinned to the workspace's active embedding space
   * and the document's current revision — the same row retrieval itself searches. A
   * leftover row from a space the workspace has moved off is not coverage.
   */
  private async readCanonicalEmbeddings(
    input: { workspaceId: string; chunkIds: string[] },
  ): Promise<Map<string, number[]>> {
    const rows = await this.db
      .selectFrom("chunk_embeddings as ce")
      .innerJoin("workspace_embedding_profiles as p", (join) =>
        join
          .onRef("p.workspace_id", "=", "ce.workspace_id")
          .onRef("p.active_embedding_space_id", "=", "ce.embedding_space_id"))
      .innerJoin("chunks as c", (join) =>
        join
          .onRef("c.workspace_id", "=", "ce.workspace_id")
          .onRef("c.id", "=", "ce.chunk_id"))
      .innerJoin("documents as d", (join) =>
        join
          .onRef("d.workspace_id", "=", "c.workspace_id")
          .onRef("d.id", "=", "c.document_id"))
      .select([
        "ce.chunk_id as id",
        sql<string | null>`ce.embedding::text`.as("embedding_text"),
      ])
      .where("ce.workspace_id", "=", input.workspaceId)
      .whereRef("ce.document_revision", "=", "d.revision")
      .where((eb) => anyOf(eb.ref("ce.chunk_id"), input.chunkIds, "uuid[]"))
      .execute();
    return toVectorMap(rows);
  }
}

const toVectorMap = (
  rows: ReadonlyArray<{ id: string; embedding_text: string | null }>,
): Map<string, number[]> =>
  new Map(rows.flatMap((row) => {
    const vector = parsePgVector(row.embedding_text);
    return vector ? [[row.id, vector] as const] : [];
  }));

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
          ...(group.excerpts?.length ? { excerpts: group.excerpts } : {}),
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
      excerpts: group.chunks
        .slice(0, EXCERPTS_PER_GROUP)
        .map((chunk) => chunk.content.trim().slice(0, EXCERPT_MAX_CHARS))
        .filter((excerpt) => excerpt.length > 0),
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
    // Every separated group must carry a parsed non-exclusive (complementary or
    // redundant) label before any candidate is tagged. Checking the deduped map per
    // group closes the partial-labeling gap: a dropped or duplicated label (invalid
    // id, non-string label, omitted group) must not let an unlabeled — potentially
    // exclusive — facet ride along untagged. Any exclusive, missing, or unparsed
    // value anywhere in the set forces every candidate back to untagged (exclusive
    // fallback), even when the rest of the set is redundant or complementary.
    const allNonExclusive = separated.every((group) => {
      const relationship = labels.get(group.documentId)?.relationship;
      return relationship !== undefined && NON_EXCLUSIVE_RELATIONSHIPS.has(relationship);
    });

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
        // Each candidate keeps its own gateway-judged value (a set can legitimately
        // mix complementary and redundant groups); only the presence of any
        // exclusive/missing member suppresses tagging for the whole set.
        ...(allNonExclusive ? { relationship: label!.relationship } : {}),
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

/**
 * Averages same-width vectors. Mixed widths have no meaningful average — summing
 * them either grows the accumulator past the first vector's width (yielding NaN)
 * or divides trailing dimensions by the full count — so the group is reported as
 * unmeasurable instead of silently producing a corrupt centroid.
 */
const centroid = (vectors: number[][]): number[] | null => {
  const first = vectors[0];
  if (!first) {
    return null;
  }
  if (vectors.some((vector) => vector.length !== first.length)) {
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

/**
 * Euclidean distance between two centroids of the same width. Vectors of
 * different widths come from different embedding spaces and are not comparable:
 * truncating to the shorter one reports 0 — "identical" — for unrelated content,
 * so the pair is reported as unmeasurable instead.
 */
const distance = (left: number[], right: number[]): number | null => {
  if (left.length !== right.length) {
    return null;
  }
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] - right[index]) ** 2;
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
    .map((otherCentroid) => distance(groupCentroid, otherCentroid))
    .filter((value): value is number => value !== null);
  // No measurable neighbour ⇒ 0, which falls below any positive separation
  // threshold, so an unmeasurable group is dropped rather than clarified on.
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
  value === "exclusive" || value === "complementary" || value === "redundant" ? value : undefined;

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
