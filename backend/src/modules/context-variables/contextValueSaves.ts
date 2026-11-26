import type { ChannelPersonKey } from "../../shared/domain/channelPersonKey.js";
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
 * What a save did. `no_person_key`: it named the person of a conversation with no person key, no
 * verified customer and no person its channel attests. `gone`: no attribute has the name any more. `not_enabled`: the conversation's release does
 * not keep the attribute's value. `unchanged`: the attribute already held the value, from the same
 * writer or from a teammate or the host, who keep it. `kept` cannot happen for a writer the
 * overwrite rule lets replace anything, and is reported for any other.
 */
export type ContextValueSaveOutcome =
  | "written"
  | "unchanged"
  | "kept"
  | "no_person_key"
  | "gone"
  | "not_enabled"
  | "refused_type"
  | "refused_trust"
  | "refused_sensitive";

/**
 * What a save reads of its conversation, in the caller's transaction: the verified customer its row
 * is bound to, the one every reader of a person value and a consent withdrawal key on; the person
 * its channel keeps a key for, a WhatsApp number, for a save whose turn carried none; and the
 * attributes the release it is pinned to keeps (`keepsStoredValue`).
 */
export interface ConversationSaveContext {
  readonly verifiedCustomerId: string | null;
  readonly channelPersonKey: ChannelPersonKey | null;
  readonly keptVariableIds: ReadonlySet<string>;
}

/** Reads a conversation's save context; a conversation that is gone keeps nothing and has no person. */
interface ConversationSaveContextReader {
  read(trx: Db, input: { workspaceId: string; conversationId: string }): Promise<ConversationSaveContext>;
}

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
   * Stores the value under the overwrite rule and records its change in the same transaction, on
   * `conversationId`, the conversation it was saved for, naming `routineId`. The caller's commit
   * wakes delivery.
   */
  storeIn(trx: Db, write: {
    definition: SaveTargetDefinition;
    scope: ContextVariableScope;
    data: unknown;
    writtenBy: ContextValueWriter;
    routineId: string | null;
    conversationId: string;
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
    conversationId: string;
    /** The person key the turn's channel attested, which a person save goes to when no verified customer is bound. */
    channelPersonKey?: ChannelPersonKey | null;
    writtenBy: ContextValueWriter;
    /** The routine whose values these are, named on each change event; null for any other writer. */
    routineId: string | null;
    saves: readonly ContextValueSaveRequest[];
  }): Promise<ContextValueSaveOutcome[]>;
}

/** A save's place in the order saves take their locks: by attribute name, then scope. */
const saveOrderKey = (request: ContextValueSaveRequest): string => `${request.variableName}\u0000${request.scope}`;

/**
 * Saves values a visitor gave, a routine's slot values at its ending, by attribute name, in a
 * transaction the caller owns, so the values and their change events commit with what the caller
 * commits or not at all. A person save goes to the customer the conversation's row is bound to, or
 * else to the person its channel attests, and only an attribute the conversation's release keeps is
 * written. Saves run by attribute and scope,
 * so two turns of one person lock its rows in one order. Each is counted by writer kind and outcome
 * (`failed` for a thrown one, which fails the caller's transaction), never by variable or value, as
 * it runs: a save its caller's transaction later rolls back stays counted.
 * The outcomes come back in the order of `saves`.
 */
export class ContextValueSaves implements ContextValueSaver {
  constructor(private readonly deps: {
    store: ContextValueSaveStore;
    conversations: ConversationSaveContextReader;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  }) {}

  async saveAll(trx: Db, input: Parameters<ContextValueSaver["saveAll"]>[1]): Promise<ContextValueSaveOutcome[]> {
    if (input.saves.length === 0) return [];
    const context = await this.deps.conversations.read(trx, { workspaceId: input.workspaceId, conversationId: input.conversationId });
    const ordered = input.saves
      .map((request, index) => ({ request, index, key: saveOrderKey(request) }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index));
    const outcomes: ContextValueSaveOutcome[] = new Array<ContextValueSaveOutcome>(input.saves.length);
    for (const { request, index } of ordered) {
      let outcome: ContextValueSaveOutcome;
      try {
        outcome = await this.save(trx, input, context, request);
      } catch (error) {
        countContextValueWrite(this.deps.metrics, input.writtenBy.kind, "failed");
        throw error;
      }
      countContextValueWrite(this.deps.metrics, input.writtenBy.kind, outcome);
      outcomes[index] = outcome;
    }
    return outcomes;
  }

  private async save(
    trx: Db,
    input: Parameters<ContextValueSaver["saveAll"]>[1],
    context: ConversationSaveContext,
    request: ContextValueSaveRequest,
  ): Promise<ContextValueSaveOutcome> {
    const scope = conversationSaveScope(request.scope, {
      conversationId: input.conversationId,
      verifiedCustomerId: context.verifiedCustomerId,
      channelPersonKey: input.channelPersonKey ?? context.channelPersonKey,
    });
    if (!scope) return "no_person_key";
    const definition = await this.deps.store.lockDefinitionNamedIn(trx, input.workspaceId, request.variableName);
    if (!definition) return "gone";
    if (!context.keptVariableIds.has(definition.id)) return "not_enabled";
    const refusal = visitorValueRefusal(definition, request);
    if (refusal) return refusal;
    return this.deps.store.storeIn(trx, {
      definition, scope, data: request.data, writtenBy: input.writtenBy, routineId: input.routineId, conversationId: input.conversationId,
    });
  }
}
