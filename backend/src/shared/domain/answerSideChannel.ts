import type { SteeringRule } from "@radioso/conversation-contract";

/** Strict-schema fields: extra `properties`, and the names among them that are `required`. */
interface AnswerSchemaFields {
  properties: Record<string, unknown>;
  required: readonly string[];
}

/**
 * A strict-schema fragment merged into an answer schema. Providers write keys in schema
 * order, so where a field sits decides what the model has already written when it fills
 * it: `properties` follow the answer, so they report on it; `beforeAnswer` fields precede
 * it, so the answer is written after them and can be held to them.
 */
export interface AnswerSchemaExtension extends AnswerSchemaFields {
  beforeAnswer?: AnswerSchemaFields;
}

/**
 * A capability-neutral hook an answer composer uses to (1) contribute extra
 * structured fields to its answer schema and (2) turn the model's opaque returned
 * fields into a metadata patch — without the composer learning what those fields
 * mean. This lets a cross-cutting concern (e.g. directive-adherence self-attestation)
 * ride any composer's structured output while the composer stays ignorant of it.
 * Composition supplies the concrete implementation; consumers depend only on this port.
 */
export interface AnswerSideChannel {
  /** Schema fragment to merge into the answer response format, or `null` to add nothing. */
  schemaExtension(): AnswerSchemaExtension | null;
  /**
   * Convert the model's uninterpreted structured fields into an opaque metadata
   * patch to attach to the turn, or `undefined` when there is nothing to attach.
   */
  resolve(extras: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
}

/**
 * Builds an {@link AnswerSideChannel} for the steering rules rendered into a turn.
 * The composer knows the turn's active steering rules (it renders them into the
 * prompt); it hands them here and gets back an opaque side channel.
 */
export interface AnswerSideChannelFactory {
  forSteeringRules(rules: readonly SteeringRule[]): AnswerSideChannel;
}
