import { isDeepStrictEqual } from "node:util";

import { AppError } from "../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  classificationRefusal,
  mayOverwrite,
  type ClassificationRefusal,
  type ContextValueWriter,
  type ContextValueWriterKind,
  type ContextVariable,
  type ContextVariableScope,
} from "./domain.js";
import type { ContextVariableRepositoryPort } from "./repository.js";
import { validateValue } from "./valueValidation.js";

export const CONTEXT_VALUE_WRITES_TOTAL = "radioso_context_value_writes_total";

/**
 * What a write to a conversation's value did. A refused or kept write is not an error: no caller
 * sees it. `gone`: the conversation or the variable was erased since the caller read it.
 */
export type ConversationValueWriteOutcome =
  | "written"
  | "cleared"
  | "unchanged"
  | "kept"
  | "gone"
  | "refused_type"
  | "refused_trust"
  | "refused_sensitive";

/** A conversation's stored value as the writer last read it, with who wrote it. */
export interface StoredConversationValue {
  readonly data: unknown;
  readonly writtenBy: ContextValueWriter;
}

type PlannedConversationWrite =
  | { action: "store"; outcome: "written" }
  | { action: "clear"; outcome: "cleared" }
  | { action: "none"; outcome: Exclude<ConversationValueWriteOutcome, "written" | "cleared"> };

const classifierRefusalOutcomes: Record<ClassificationRefusal, PlannedConversationWrite> = {
  not_choice: { action: "none", outcome: "refused_type" },
  private: { action: "none", outcome: "refused_sensitive" },
  proof: { action: "none", outcome: "refused_trust" },
};

/**
 * What a writer does to a conversation's value. `data: null` clears it. The overwrite rule decides
 * against `stored`: the classifier fills an empty value or replaces its own, so a value the host, a
 * teammate or a routine set stays, and its `null` clears only its own value. A value equal to the one
 * the same kind of writer stored writes nothing. The classifier never writes a variable it may not
 * fill (`classificationRefusal`), whatever its authoring allowed when it was enabled.
 */
export const planConversationWrite = (input: {
  variable: Pick<ContextVariable, "valueType" | "options" | "sensitivity" | "trustTier">;
  stored: StoredConversationValue | null;
  data: unknown;
  writer: ContextValueWriterKind;
}): PlannedConversationWrite => {
  const { stored, data, writer } = input;
  const refusal = writer === "classifier" ? classificationRefusal(input.variable) : null;
  if (refusal) return classifierRefusalOutcomes[refusal];
  if (data === null) {
    if (!stored) return { action: "none", outcome: "unchanged" };
    return mayOverwrite(stored.writtenBy, writer) ? { action: "clear", outcome: "cleared" } : { action: "none", outcome: "kept" };
  }
  if (!validateValue(input.variable, data).ok) return { action: "none", outcome: "refused_type" };
  if (stored && stored.writtenBy.kind === writer && isDeepStrictEqual(stored.data, data)) {
    return { action: "none", outcome: "unchanged" };
  }
  if (stored && !mayOverwrite(stored.writtenBy, writer)) return { action: "none", outcome: "kept" };
  return { action: "store", outcome: "written" };
};

/** Writes one conversation's value of one variable, for a writer that is not an HTTP caller. */
export interface ConversationValueWriter {
  write(input: {
    conversationId: string;
    variable: ContextVariable;
    /** The value the caller read for this conversation, which decides what the write does. */
    stored: StoredConversationValue | null;
    data: unknown;
    writtenBy: ContextValueWriter;
  }): Promise<ConversationValueWriteOutcome>;
}

/**
 * The store-backed writer. The plan is decided against the caller's read; the store then applies the
 * overwrite rule again inside its own statement, so a write another writer made since the read is
 * kept. A conversation or variable erased since the read reports `gone`; any other failure is thrown
 * to the caller. Each write is counted by writer kind and outcome (`failed` for a thrown one), never
 * by variable or value.
 */
export class ConversationValueWriterService implements ConversationValueWriter {
  constructor(private readonly deps: {
    repository: Pick<ContextVariableRepositoryPort, "upsertValue" | "deleteValueWrittenBy">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  }) {}

  async write(input: Parameters<ConversationValueWriter["write"]>[0]): Promise<ConversationValueWriteOutcome> {
    let outcome: ConversationValueWriteOutcome;
    try {
      outcome = await this.apply(input);
    } catch (error) {
      const erased = error instanceof AppError && error.statusCode === 404;
      this.count(input.writtenBy.kind, erased ? "gone" : "failed");
      if (!erased) throw error;
      return "gone";
    }
    this.count(input.writtenBy.kind, outcome);
    return outcome;
  }

  private count(writer: ContextValueWriterKind, outcome: ConversationValueWriteOutcome | "failed"): void {
    this.deps.metrics?.incrementCounter(CONTEXT_VALUE_WRITES_TOTAL, {
      help: "Writes to a conversation's attribute value by writer kind and outcome.",
      labels: { writer, outcome },
    });
  }

  private async apply(input: Parameters<ConversationValueWriter["write"]>[0]): Promise<ConversationValueWriteOutcome> {
    const plan = planConversationWrite({ variable: input.variable, stored: input.stored, data: input.data, writer: input.writtenBy.kind });
    const scope: ContextVariableScope = { type: "conversation", id: input.conversationId };
    if (plan.action === "store") {
      const saved = await this.deps.repository.upsertValue(input.variable.id, scope, input.data, input.writtenBy);
      return saved ? "written" : "kept";
    }
    if (plan.action === "clear") {
      const replaceable = CONTEXT_VALUE_WRITER_KINDS.filter((kind) => mayOverwrite({ kind, ref: null }, input.writtenBy.kind));
      return await this.deps.repository.deleteValueWrittenBy(input.variable.id, scope, replaceable, input.writtenBy) ? "cleared" : "kept";
    }
    return plan.outcome;
  }
}
