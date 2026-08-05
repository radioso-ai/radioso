import type { RoutineActivationPrefilter } from "@radioso/conversation-defaults";

import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import type { ClusteringEmbeddingPort } from "../embeddingProfiles/contracts/embeddingConsumers.js";
import type { AppLogger } from "../../shared/observability/logger.js";

const ROUTINE_ACTIVATION_PREFILTER_TOP_K = 8;
const ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE = 0.2;
// Bounds per-turn background embedding fan-out while unembedded published
// rows (pre-migration-128 catalogs, or a changed workspace embedding model)
// converge to persisted vectors over successive turns.
const ROUTINE_TRIGGER_SELF_HEAL_PER_TURN = 16;
const routineDefinitionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
};

export interface RoutineActivationPrefilterDependencies {
  accountId?: string;
  clusteringEmbeddings: ClusteringEmbeddingPort;
  embeddingModelForWorkspace: (workspaceId: string) => Promise<string>;
  logger: Pick<AppLogger, "debug" | "warn">;
  routineDefinitionRepository: Pick<RoutineDefinitionRepository, "searchActivationTriggerEmbeddings">;
  selfHealTriggerEmbedding?: (input: {
    routineId: string;
    description: string;
    embedding: readonly number[];
    model: string;
  }) => void;
  workspaceId: string;
}

export const createRoutineActivationPrefilter = (
  input: RoutineActivationPrefilterDependencies,
): RoutineActivationPrefilter => ({
  minScore: ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE,
  topK: ROUTINE_ACTIVATION_PREFILTER_TOP_K,
  async rank({ query, triggers, turn }) {
    if (triggers.length === 0) {
      return [];
    }
    const usage = (attemptKey: string) => ({
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId,
      conversationId: turn.sessionId,
      messageId: turn.inputEvent.id ?? null,
      surface: "assistant" as const,
      operation: "routine_activation_embedding",
      attemptKey,
    });
    let embeddingModel: string;
    let queryVector: number[] | undefined;
    try {
      embeddingModel = await input.embeddingModelForWorkspace(input.workspaceId);
      const { vectors } = await input.clusteringEmbeddings.embedForClustering({
        workspaceId: input.workspaceId,
        texts: [query],
        usageContext: usage("routine_activation_prefilter"),
      });
      [queryVector] = vectors;
      if (!queryVector) {
        throw new Error("routine_activation_query_embedding_missing");
      }
    } catch (error) {
      // Rethrow so the registry falls back to the FULL unpruned candidate set;
      // pruning to an arbitrary subset on failure would silently lose recall.
      input.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          workspaceId: input.workspaceId,
          routineTriggerCount: triggers.length,
        },
        "Routine activation prefilter failed to embed the query; falling back to unpruned ranked activation",
      );
      throw error;
    }

    const descriptionsById = new Map(triggers.map((trigger) => [trigger.routineId, trigger.description]));
    const scored: Array<{ routineId: string; score: number }> = [];
    let unscoredIds: string[];
    let mode: "persisted" | "fly_only" = "persisted";
    try {
      const result = await input.routineDefinitionRepository.searchActivationTriggerEmbeddings({
        candidateRoutineIds: triggers
          .map((trigger) => trigger.routineId)
          .filter((routineId) => routineDefinitionIdPattern.test(routineId)),
        embeddingModel,
        queryEmbedding: queryVector,
        topK: ROUTINE_ACTIVATION_PREFILTER_TOP_K,
      });
      scored.push(...result.matches.map(({ routineId, distance }) => ({ routineId, score: 1 - distance })));
      unscoredIds = [
        ...result.noVectorRoutineIds,
        ...triggers
          .map((trigger) => trigger.routineId)
          .filter((routineId) => !routineDefinitionIdPattern.test(routineId)),
      ];
    } catch (error) {
      // Persisted search unavailable: score the whole set on the fly (the
      // pre-persistence behavior) instead of degrading to guesswork.
      mode = "fly_only";
      unscoredIds = triggers.map((trigger) => trigger.routineId);
      input.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          workspaceId: input.workspaceId,
          routineTriggerCount: triggers.length,
        },
        "Routine activation trigger search failed; scoring all candidates on the fly",
      );
    }

    // Candidates without a usable persisted vector (in-code registrations,
    // workbench previews, legacy pre-128 rows, model mismatch) are embedded on
    // the fly so EVERY candidate competes on a real similarity score — an
    // unscorable candidate must never outrank a scored match.
    const flyVectorsById = new Map<string, number[]>();
    if (unscoredIds.length > 0) {
      try {
        const { vectors } = await input.clusteringEmbeddings.embedForClustering({
          workspaceId: input.workspaceId,
          texts: unscoredIds.map((routineId) => descriptionsById.get(routineId) ?? ""),
          usageContext: usage("routine_activation_prefilter_fly"),
        });
        unscoredIds.forEach((routineId, index) => {
          const vector = vectors[index];
          if (vector) {
            flyVectorsById.set(routineId, vector);
            scored.push({ routineId, score: cosineSimilarity(queryVector, vector) });
          } else {
            scored.push({ routineId, score: ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE });
          }
        });
      } catch (error) {
        if (mode === "fly_only") {
          input.logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              workspaceId: input.workspaceId,
              routineTriggerCount: triggers.length,
            },
            "Routine activation prefilter failed entirely; falling back to unpruned ranked activation",
          );
          throw error;
        }
        // Partial degradation: keep persisted scores; unscorable candidates
        // survive at exactly the floor — able to reach ranking, never able to
        // displace a real match.
        unscoredIds.forEach((routineId) => {
          scored.push({ routineId, score: ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE });
        });
      }
    }

    // Self-heal: persist the fly-computed vectors for DB-backed rows (legacy
    // pre-128 catalogs, or stale after an embedding-model change) so they move
    // to the persisted path on later turns. Reuses the vectors computed above —
    // no extra embedding calls — and stays bounded per turn. Drafts self-skip
    // in the service (no published row).
    if (input.selfHealTriggerEmbedding) {
      let healed = 0;
      for (const routineId of unscoredIds) {
        if (healed >= ROUTINE_TRIGGER_SELF_HEAL_PER_TURN) break;
        if (!routineDefinitionIdPattern.test(routineId)) continue;
        const embedding = flyVectorsById.get(routineId);
        const description = descriptionsById.get(routineId);
        if (!embedding || !description) continue;
        input.selfHealTriggerEmbedding({ routineId, description, embedding, model: embeddingModel });
        healed += 1;
      }
    }

    const kept = scored.filter((candidate) => candidate.score >= ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE);
    input.logger.debug(
      {
        mode,
        candidateCountBefore: triggers.length,
        candidateCountAfter: kept.length,
        flyEmbeddedCount: flyVectorsById.size,
        candidateRoutineIds: triggers.map((trigger) => trigger.routineId),
        keptRoutineIds: kept.map((candidate) => candidate.routineId),
      },
      "Routine activation prefilter completed",
    );
    return kept;
  },
});
