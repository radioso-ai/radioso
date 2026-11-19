import { z } from "zod";

import { CALLER_KINDS } from "./conversationSource.js";
import type { Db } from "../infra/kysely/types.js";

/**
 * The workspace event log's published contract (#1851): the business events an automation acts
 * on, what each one carries, and the port an owning module records one through. The owning module
 * builds the event from its own facts; the log stores and serves it, and knows nothing about the
 * chat turn, routine or decision that produced it.
 */

/** Every type the log records, by the name a client filters and subscribes by. */
export const WORKSPACE_EVENT_TYPES = [
  "conversation.started",
  "contact_request.created",
  "handoff.requested",
  "routine.completed",
  "decision.pending",
] as const;

export type WorkspaceEventType = typeof WORKSPACE_EVENT_TYPES[number];

/**
 * The schema version each type is written with. A field added to a type keeps its version; a change
 * that breaks a reader is written as a new version beside the old one until readers move.
 */
export const WORKSPACE_EVENT_VERSIONS: Readonly<Record<WorkspaceEventType, number>> = {
  "conversation.started": 1,
  "contact_request.created": 1,
  "handoff.requested": 1,
  "routine.completed": 1,
  "decision.pending": 1,
};

/** How long the log keeps an event. Fixed rather than a setting: clients page well inside it. */
export const WORKSPACE_EVENT_RETENTION_DAYS = 30;

/** How a routine run ended: an authored terminal step's kind, or one of the runner's own endings. */
export const ROUTINE_EVENT_OUTCOMES = ["complete", "handoff", "action", "stuck", "consent_declined"] as const;

export type RoutineEventOutcome = typeof ROUTINE_EVENT_OUTCOMES[number];

const slotValues = z.record(z.string(), z.unknown())
  .describe("Values keyed by slot key, as they left the conversation: a sensitive slot's value reads `[redacted]`.");

/** What every conversation event names. The log copies it from the conversation when it records the event. */
const conversationEventSubjectSchema = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid().nullable().describe("The agent the conversation is with; null once that agent is deleted."),
  channel: z.string().nullable().describe("The channel the conversation arrived on, as history's `sourceChannel` names it."),
  callerKind: z.enum(CALLER_KINDS).describe("`human` for a person, `agent` for software calling the agent."),
  visitorId: z.string().uuid().nullable().describe("The visitor the conversation belongs to, when the channel identifies one."),
});

/** What each type adds to the conversation it names. */
const workspaceEventDetailSchemas = {
  "conversation.started": z.object({}),
  "contact_request.created": z.object({
    contactRequestId: z.string().uuid().describe("The contact request, as `GET /api/v1/history/contact/{requestId}` reads it."),
    values: slotValues,
  }),
  "handoff.requested": z.object({
    reason: z.string().describe("Why the agent handed the conversation to a person, as a handoff reason code such as `routine_handoff` or `retrieval_miss`."),
  }),
  "routine.completed": z.object({
    routineId: z.string(),
    executionId: z.string().nullable().describe("The routine run. A visitor's later correction to the run's values records the run again under the same id."),
    outcome: z.enum(ROUTINE_EVENT_OUTCOMES).describe("How the run ended: at an authored `complete`, `handoff` or `action` ending, `stuck` past its re-ask limit, or `consent_declined`."),
    values: slotValues,
    sensitiveSlotKeys: z.array(z.string()).describe("The keys in `values` that are sensitive, whose values are masked."),
  }),
  "decision.pending": z.object({
    decisionHandle: z.string(),
    routineId: z.string(),
    stepId: z.string(),
    reason: z.string().nullable().describe("The reason the routine's author wrote on the decision step."),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    deadline: z.string().datetime().nullable(),
  }),
} as const satisfies Record<WorkspaceEventType, z.ZodObject>;

export type WorkspaceEventDetail<T extends WorkspaceEventType> = z.infer<typeof workspaceEventDetailSchemas[T]>;

/** The `data` of one type as served: the conversation it names, then what the type adds. */
export const workspaceEventDataSchema = <T extends WorkspaceEventType>(type: T) =>
  conversationEventSubjectSchema.extend(workspaceEventDetailSchemas[type].shape);

/** One event as the log serves it, and as a subscription receives it. */
export interface WorkspaceEvent {
  id: string;
  type: WorkspaceEventType;
  version: number;
  occurredAt: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

/**
 * An event as its owner records it: the conversation it is about and what the type adds. The log
 * fills in the rest of the conversation's fields.
 */
export type WorkspaceEventDraft = {
  [T in WorkspaceEventType]: {
    type: T;
    workspaceId: string;
    conversationId: string;
    /** Names the fact, so a second write of the same fact is dropped. Absent when every write is a new fact. */
    idempotencyKey?: string;
    detail: WorkspaceEventDetail<T>;
  };
}[WorkspaceEventType];

/**
 * Records an event in the transaction the change it describes runs in: pass that transaction as
 * `db`. A failed write throws, so the change rolls back with it, and neither commits without the
 * other. A conversation that operator testing produced, or that no longer exists, records nothing,
 * as history's own lists leave it out.
 */
export interface WorkspaceEventRecorder {
  record(db: Db, draft: WorkspaceEventDraft): Promise<void>;
}
