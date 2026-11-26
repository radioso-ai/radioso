import { isDeepStrictEqual } from "node:util";

import {
  CONTEXT_VALUE_EVENT_SCOPES,
  CONTEXT_VALUE_EVENT_VALUE_TYPES,
  CONTEXT_VALUE_EVENT_WRITERS,
  type ContextValueEventScope,
  type WorkspaceEventDetail,
} from "../../shared/domain/workspaceEventLog.js";
import type { SameType } from "../../shared/types/sameType.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_VALUE_TYPES,
  type ContextValueWriter,
  type ContextVariable,
  type ContextVariableScopeType,
  type ConversationScopeType,
} from "./domain.js";

// The published event names every type and writer kind this module has: one added here fails tsc
// until the event contract lists it, and the OpenAPI document and SDK follow from there.
const valueTypesPublished: SameType<typeof CONTEXT_VARIABLE_VALUE_TYPES[number], typeof CONTEXT_VALUE_EVENT_VALUE_TYPES[number]> = true;
const writersPublished: SameType<typeof CONTEXT_VALUE_WRITER_KINDS[number], typeof CONTEXT_VALUE_EVENT_WRITERS[number]> = true;
void valueTypesPublished;
void writersPublished;

/**
 * Whether a change of a value kept at `scope` is recorded, and under which published scope: a
 * conversation's own value, or a person value saved in a conversation. A session's value spans
 * conversations and an agent's or workspace's is a default, so neither names one.
 */
export const contextValueEventScope = (scope: ContextVariableScopeType): ContextValueEventScope | null =>
  (CONTEXT_VALUE_EVENT_SCOPES as readonly string[]).includes(scope) ? scope as ContextValueEventScope : null;
// A save goes to the conversation or its person: a person rung added to the ladder fails tsc here until it is published.
const saveScopesPublished: SameType<ContextValueEventScope, Exclude<ConversationScopeType, "session">> = true;
void saveScopesPublished;

/** A value change as the log records it: the conversation it names and what changed. */
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
 * The `context_value.changed` event for a conversation's value, or a person value a routine saved in
 * the conversation, as the writer that changed it records it in its own transaction. The person's key
 * stays out: a customer id is the host's, and a WhatsApp number is never sent. `value: null` is a cleared value. A Private attribute's event never
 * carries its value, set or cleared, so a reader can't tell one from the other by the payload. The
 * writer's reference stays out, other than a routine's id, which consent withdrawal removes the
 * events of: a token id or a teammate's user id is not the automation's to read. The routine's id
 * comes from the writer that saved the value, never read back out of its reference.
 */
export const contextValueChangedEvent = (input: {
  workspaceId: string;
  conversationId: string;
  /** Where the value is kept; the conversation's own when left out. */
  scope?: ContextValueEventScope;
  variable: Pick<ContextVariable, "id" | "name" | "valueType" | "sensitivity">;
  value: unknown;
  writtenBy: ContextValueWriter;
  /** The routine whose value it is; null for any other writer. */
  routineId: string | null;
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
      scope: input.scope ?? "conversation",
      value: redacted ? null : input.value,
      redacted,
      writtenBy: input.writtenBy.kind,
      routineId: input.writtenBy.kind === "routine" ? input.routineId : null,
    },
  };
};
