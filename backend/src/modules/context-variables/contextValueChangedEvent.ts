import { isDeepStrictEqual } from "node:util";

import {
  CONTEXT_VALUE_EVENT_VALUE_TYPES,
  CONTEXT_VALUE_EVENT_WRITERS,
  type WorkspaceEventDetail,
} from "../../shared/domain/workspaceEventLog.js";
import type { SameType } from "../../shared/types/sameType.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_VALUE_TYPES,
  type ContextValueWriter,
  type ContextVariable,
} from "./domain.js";

// The published event names every type and writer kind this module has: one added here fails tsc
// until the event contract lists it, and the OpenAPI document and SDK follow from there.
const valueTypesPublished: SameType<typeof CONTEXT_VARIABLE_VALUE_TYPES[number], typeof CONTEXT_VALUE_EVENT_VALUE_TYPES[number]> = true;
const writersPublished: SameType<typeof CONTEXT_VALUE_WRITER_KINDS[number], typeof CONTEXT_VALUE_EVENT_WRITERS[number]> = true;
void valueTypesPublished;
void writersPublished;

/** A conversation's value change as the log records it: the conversation it names and what changed. */
interface ContextValueChangedDraft {
  readonly type: "context_value.changed";
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly detail: WorkspaceEventDetail<"context_value.changed">;
}

/**
 * Whether a write changed what a scope holds. `undefined` is no stored value. Only the value counts:
 * a teammate who sets the option the AI picked changes who holds it, not what it is.
 */
export const contextValueChanged = (previous: unknown, next: unknown): boolean =>
  !isDeepStrictEqual(previous, next);

/**
 * The routine a routine-written value came from. A routine writes under `routineId:executionId`,
 * and an execution id holds no colon, so the routine id is everything before the last one.
 */
const routineIdOf = (writer: ContextValueWriter): string | null => {
  if (writer.kind !== "routine" || !writer.ref) return null;
  const separator = writer.ref.lastIndexOf(":");
  return separator > 0 ? writer.ref.slice(0, separator) : writer.ref;
};

/**
 * The `context_value.changed` event for a conversation's value, as the writer that changed it records
 * it in its own transaction. `value: null` is a cleared value. A Private attribute's event never
 * carries its value, set or cleared, so a reader can't tell one from the other by the payload. The
 * writer's reference stays out, other than a routine's id, which consent withdrawal removes the
 * events of: a token id or a teammate's user id is not the automation's to read.
 */
export const contextValueChangedEvent = (input: {
  workspaceId: string;
  conversationId: string;
  variable: Pick<ContextVariable, "id" | "name" | "valueType" | "sensitivity">;
  value: unknown;
  writtenBy: ContextValueWriter;
}): ContextValueChangedDraft => {
  const redacted = input.variable.sensitivity === "sensitive";
  return {
    type: "context_value.changed",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    detail: {
      variableId: input.variable.id,
      variable: input.variable.name,
      valueType: input.variable.valueType,
      scope: "conversation",
      value: redacted ? null : input.value,
      redacted,
      writtenBy: input.writtenBy.kind,
      routineId: routineIdOf(input.writtenBy),
    },
  };
};
