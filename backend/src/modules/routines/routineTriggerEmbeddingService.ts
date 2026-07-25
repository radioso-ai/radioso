import { createHash } from "node:crypto";

import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";

export interface RoutineTriggerEmbeddingStore {
  get(input: { agentId: string; routineId: string }): Promise<{ hash: string | null } | null>;
  save(input: {
    agentId: string;
    routineId: string;
    embedding: readonly number[];
    model: string;
    hash: string;
  }): Promise<void>;
  clear(input: { agentId: string; routineId: string }): Promise<void>;
}

export interface RoutineTriggerEmbeddingServiceOptions {
  embeddings: {
    embedTexts(texts: string[], options?: { model?: string; usageContext?: ModelCallUsageContext }): Promise<number[][]>;
  };
  settings: {
    getForWorkspace(workspaceId: string): Promise<{ embeddingModel: string }>;
  };
  store: RoutineTriggerEmbeddingStore;
  logger: { warn(bindings: { routineId: string }, message: string): void };
}

const triggerHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Best-effort persistence for published routine activation triggers. */
export class RoutineTriggerEmbeddingService {
  // Concurrent-call dedup only (cleared on settle): the activation prefilter
  // self-heals unembedded rows fire-and-forget, and overlapping turns must not
  // fan out duplicate embedding calls for the same trigger content.
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: RoutineTriggerEmbeddingServiceOptions) {}

  async persistPublished(input: {
    workspaceId: string;
    agentId: string;
    // Structural on purpose: satisfied by RoutineDefinition, and by the
    // prefilter self-heal path which only holds id + trigger description.
    routine: { id: string; activation: { triggerDescription: string } };
  }): Promise<void> {
    const hash = triggerHash(input.routine.activation.triggerDescription);
    const inFlightKey = `${input.agentId}:${input.routine.id}:${hash}`;
    if (this.inFlight.has(inFlightKey)) return;
    this.inFlight.add(inFlightKey);
    try {
      const existing = await this.options.store.get({ agentId: input.agentId, routineId: input.routine.id });
      // No published row (draft under workbench preview, or deleted since the
      // turn started): nothing to persist, and no cleanup to do.
      if (!existing) return;
      if (existing.hash === hash) return;

      const settings = await this.options.settings.getForWorkspace(input.workspaceId);
      const [embedding] = await this.options.embeddings.embedTexts([input.routine.activation.triggerDescription], {
        model: settings.embeddingModel,
        usageContext: {
          workspaceId: input.workspaceId,
          surface: "assistant",
          operation: "routine_activation_trigger_embedding",
          attemptKey: input.routine.id,
        },
      });
      if (!embedding) throw new Error("routine_trigger_embedding_missing");

      await this.options.store.save({
        agentId: input.agentId,
        routineId: input.routine.id,
        embedding,
        model: settings.embeddingModel,
        hash,
      });
    } catch {
      try {
        await this.options.store.clear({ agentId: input.agentId, routineId: input.routine.id });
      } catch {
        // A failed cleanup cannot make an already-published routine fail.
      }
      this.options.logger.warn({ routineId: input.routine.id }, "Routine trigger embedding persistence failed");
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }
}
