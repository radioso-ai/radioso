import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { countContextValueWrite } from "./conversationValueWriter.js";
import {
  conversationSaveScope,
  type ContextValueWriter,
  type ContextVariable,
  type ContextVariableScope,
  type ConversationSaveScope,
} from "./domain.js";
import { validateValue } from "./valueValidation.js";

/** A variable's definition as a save reads it, key-shared until the caller's transaction commits. */
export type SaveTargetDefinition = Pick<
  ContextVariable,
  "id" | "workspaceId" | "name" | "valueType" | "options" | "trustTier" | "sensitivity"
>;

/**
 * What a save did. `no_person_key`: it named the person of a conversation that has no verified
 * person. `gone`: no attribute has the name any more. `kept` cannot happen for a writer the
 * overwrite rule lets replace anything, and is reported for any other.
 */
export type ContextValueSaveOutcome =
  | "written"
  | "unchanged"
  | "kept"
  | "no_person_key"
  | "gone"
  | "refused_type"
  | "refused_trust"
  | "refused_sensitive";

/** One value to save for a conversation, by the attribute's name. */
export interface ContextValueSaveRequest {
  readonly variableName: string;
  readonly scope: ConversationSaveScope;
  readonly data: unknown;
  /** Whether the value came from a field its author marked sensitive: it goes only to a Private attribute. */
  readonly sensitive: boolean;
}

/** The store a save runs on, in a transaction its caller owns. */
export interface ContextValueSaveStore {
  /** The workspace's variable of that name, key-shared for the rest of the transaction; null when none has it. */
  lockDefinitionNamedIn(trx: Db, workspaceId: string, name: string): Promise<SaveTargetDefinition | null>;
  /**
   * Stores the value under the overwrite rule and records a conversation value's change in the same
   * transaction, naming `routineId`. The caller's commit wakes delivery.
   */
  storeIn(trx: Db, write: {
    definition: SaveTargetDefinition;
    scope: ContextVariableScope;
    data: unknown;
    writtenBy: ContextValueWriter;
    routineId: string | null;
  }): Promise<"written" | "unchanged" | "kept">;
}

/**
 * Why a value the visitor gave is not saved to `variable`, checked against the attribute as it is
 * now, since its definition is not revisioned and may have changed since the save was authored. A
 * visitor's value is never proof, a sensitive one goes only to a Private attribute, and the value
 * must fit the type.
 */
const visitorValueRefusal = (
  variable: SaveTargetDefinition,
  request: Pick<ContextValueSaveRequest, "data" | "sensitive">,
): "refused_type" | "refused_trust" | "refused_sensitive" | null => {
  if (variable.trustTier === "signed") return "refused_trust";
  if (request.sensitive && variable.sensitivity !== "sensitive") return "refused_sensitive";
  return validateValue(variable, request.data).ok ? null : "refused_type";
};

/** Saves the values a writer gives for one conversation, in the writer's own transaction. */
export interface ContextValueSaver {
  saveAll(trx: Db, input: {
    workspaceId: string;
    conversation: { id: string; verifiedCustomerId: string | null };
    writtenBy: ContextValueWriter;
    /** The routine whose values these are, named on each change event; null for any other writer. */
    routineId: string | null;
    saves: readonly ContextValueSaveRequest[];
  }): Promise<ContextValueSaveOutcome[]>;
}

/**
 * Saves values a visitor gave, a routine's slot values at its ending, by attribute name, in a
 * transaction the caller owns, so the values and their change events commit with what the caller
 * commits or not at all. Each is counted by writer kind and outcome (`failed` for a thrown one,
 * which fails the caller's transaction), never by variable or value. The outcomes come back in the
 * order of `saves`.
 */
export class ContextValueSaves implements ContextValueSaver {
  constructor(private readonly deps: {
    store: ContextValueSaveStore;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  }) {}

  async saveAll(trx: Db, input: Parameters<ContextValueSaver["saveAll"]>[1]): Promise<ContextValueSaveOutcome[]> {
    const outcomes: ContextValueSaveOutcome[] = [];
    for (const request of input.saves) {
      let outcome: ContextValueSaveOutcome;
      try {
        outcome = await this.save(trx, input, request);
      } catch (error) {
        countContextValueWrite(this.deps.metrics, input.writtenBy.kind, "failed");
        throw error;
      }
      countContextValueWrite(this.deps.metrics, input.writtenBy.kind, outcome);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async save(
    trx: Db,
    input: Parameters<ContextValueSaver["saveAll"]>[1],
    request: ContextValueSaveRequest,
  ): Promise<ContextValueSaveOutcome> {
    const scope = conversationSaveScope(request.scope, { conversationId: input.conversation.id, verifiedCustomerId: input.conversation.verifiedCustomerId });
    if (!scope) return "no_person_key";
    const definition = await this.deps.store.lockDefinitionNamedIn(trx, input.workspaceId, request.variableName);
    if (!definition) return "gone";
    const refusal = visitorValueRefusal(definition, request);
    if (refusal) return refusal;
    return this.deps.store.storeIn(trx, { definition, scope, data: request.data, writtenBy: input.writtenBy, routineId: input.routineId });
  }
}
