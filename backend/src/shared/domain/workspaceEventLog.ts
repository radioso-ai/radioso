import { z } from "zod";

import { CALLER_KINDS } from "./conversationSource.js";
import { CONVERSATION_OWNERSHIP_REASONS, type ConversationOwnershipReasonCode } from "./conversationOwnershipReasons.js";
import type { Db } from "../infra/kysely/types.js";

/**
 * The workspace event log's published contract (#1851): the business events an automation acts
 * on, what each one carries, the port an owning module records one through, and the port the log
 * reads its store through. The owning module builds the event from its own facts; the log stores
 * and serves it, and knows nothing about the chat turn, routine, decision or document job that
 * produced it.
 */

/** The types about a conversation: each one names the conversation it happened in. */
const CONVERSATION_EVENT_TYPES = [
  "conversation.started",
  "contact_request.created",
  "handoff.requested",
  "routine.completed",
  "decision.pending",
] as const;

/** The types about a document: each one names the document revision it happened to. */
const DOCUMENT_EVENT_TYPES = ["document.processed", "document.failed"] as const;

/** Every type the log records, by the name a client filters and subscribes by. */
export const WORKSPACE_EVENT_TYPES = [...CONVERSATION_EVENT_TYPES, ...DOCUMENT_EVENT_TYPES] as const;

export type WorkspaceEventType = typeof WORKSPACE_EVENT_TYPES[number];
type ConversationEventType = typeof CONVERSATION_EVENT_TYPES[number];
type DocumentEventType = typeof DOCUMENT_EVENT_TYPES[number];

export const isDocumentEventType = (type: WorkspaceEventType): type is DocumentEventType =>
  (DOCUMENT_EVENT_TYPES as readonly WorkspaceEventType[]).includes(type);

/**
 * The schema version each type is written with. A field added to a type keeps its version; a change
 * that breaks a reader is written as a new version beside the old one until readers move.
 */
export const WORKSPACE_EVENT_VERSIONS = {
  "conversation.started": 1,
  "contact_request.created": 1,
  "handoff.requested": 1,
  "routine.completed": 1,
  "decision.pending": 1,
  "document.processed": 1,
  "document.failed": 1,
} as const satisfies Record<WorkspaceEventType, number>;

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
  agentId: z.string().uuid().nullable().describe("The agent the conversation was with when the event was recorded."),
  channel: z.string().nullable().describe("The channel the conversation arrived on, as history's `sourceChannel` names it."),
  callerKind: z.enum(CALLER_KINDS).describe("`human` for a person, `agent` for software calling the agent."),
  visitorId: z.string().uuid().nullable().describe("The visitor the conversation belonged to when the event was recorded, when the channel identifies one."),
});

/**
 * What every document event names. The log copies the title and source from the document when it
 * records the event.
 */
const documentEventSubjectSchema = z.object({
  documentId: z.string().uuid(),
  revision: z.number().int().positive().describe("The document revision the event is about. A changed document is processed again as its next revision."),
  title: z.string().describe("The document's title when the event was recorded."),
  sourceKind: z.enum(["inline_text", "uploaded_file"]).describe("How the content arrived, as the document's own `sourceKind`: `inline_text` for text, `uploaded_file` for a file."),
  sourceId: z.string().uuid().nullable().describe("The document source the document belongs to: a crawled website, a connector or an API source. Null for a document added on its own."),
});

/**
 * What each type adds to the subject it names, as its owner builds it. Written out rather than
 * inferred from the schemas below, which keeps the type checker's work small; the contract and
 * integration tests parse every served event against those schemas.
 */
interface WorkspaceEventDetails {
  "conversation.started": Record<string, never>;
  "contact_request.created": { contactRequestId: string; values: Record<string, unknown> };
  "handoff.requested": { reason: ConversationOwnershipReasonCode };
  "routine.completed": {
    routineId: string;
    executionId: string | null;
    outcome: RoutineEventOutcome;
    values: Record<string, unknown>;
    sensitiveSlotKeys: string[];
  };
  "decision.pending": {
    decisionHandle: string;
    routineId: string;
    stepId: string;
    reason: string | null;
    options: Array<{ id: string; label: string }>;
    deadline: string | null;
  };
  "document.processed": Record<string, never>;
  "document.failed": { failureCode: string | null };
}

export type WorkspaceEventDetail<T extends WorkspaceEventType> = WorkspaceEventDetails[T];

/** The published schema of what each type adds. */
const workspaceEventDetailSchemas: Readonly<Record<WorkspaceEventType, z.ZodObject>> = {
  "conversation.started": z.object({}),
  "contact_request.created": z.object({
    contactRequestId: z.string().uuid().describe("The queued contact request's stable id. Read the conversation it came from with `GET /api/v1/history/chat/{conversationId}`."),
    values: slotValues,
  }),
  "handoff.requested": z.object({
    reason: z.enum(CONVERSATION_OWNERSHIP_REASONS).describe("Why the conversation went to a person, as a handoff reason code."),
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
  "document.processed": z.object({}),
  "document.failed": z.object({
    failureCode: z.string().nullable().describe("Why processing failed, as an error code such as `provider_misconfigured`. Null when the failure carried no code. The failure's message is never included."),
  }),
};

/** The `data` of one type as served: the conversation or document it names, then what the type adds. */
export const workspaceEventDataSchema = (type: WorkspaceEventType): z.ZodObject =>
  (isDocumentEventType(type) ? documentEventSubjectSchema : conversationEventSubjectSchema)
    .extend(workspaceEventDetailSchemas[type].shape);

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
 * A conversation event as its owner records it: the conversation it is about and what the type
 * adds. The log fills in the rest of the conversation's fields.
 */
type ConversationEventDraft = {
  [T in ConversationEventType]: {
    type: T;
    workspaceId: string;
    conversationId: string;
    /** Names the fact, so a second write of the same fact is dropped. Absent when every write is a new fact. */
    idempotencyKey?: string;
    detail: WorkspaceEventDetail<T>;
  };
}[ConversationEventType];

/**
 * A document event as its owner records it: the document revision it is about and what the type
 * adds. The log fills in the document's title and source.
 */
export type DocumentEventDraft = {
  [T in DocumentEventType]: {
    type: T;
    workspaceId: string;
    documentId: string;
    revision: number;
    /** Names the fact, so a second write of the same fact is dropped. */
    idempotencyKey: string;
    detail: WorkspaceEventDetail<T>;
  };
}[DocumentEventType];

export type WorkspaceEventDraft = ConversationEventDraft | DocumentEventDraft;

export const isDocumentEventDraft = (draft: WorkspaceEventDraft): draft is DocumentEventDraft => isDocumentEventType(draft.type);

/**
 * Records an event in the transaction the change it describes runs in: pass that transaction as
 * `db`. A failed write throws, so the change rolls back with it, and neither commits without the
 * other. A conversation that operator testing produced, or that no longer exists, records nothing,
 * as history's own lists leave it out; so does a document that is gone or has moved on to a newer
 * revision.
 */
export interface WorkspaceEventRecorder {
  record(db: Db, draft: WorkspaceEventDraft): Promise<void>;
}

/** A place in the log: the writing transaction's id and the row's position, both decimal text. */
export interface LogPosition {
  tx: string;
  position: string;
}

/**
 * One stored event as the store reads it, with its place in the log. The conversation fields are
 * null for a document event, whose `data` names its document.
 */
export interface StoredLogEvent extends LogPosition {
  id: string;
  workspaceId: string;
  type: WorkspaceEventType;
  version: number;
  occurredAt: Date;
  conversationId: string | null;
  agentId: string | null;
  channel: string | null;
  callerKind: string | null;
  visitorId: string | null;
  data: Record<string, unknown>;
}

/**
 * Where the log reads from. A page below one snapshot's horizon, and that horizon: the events after
 * `after` in (transaction, position) order, oldest first, or with no `after` the newest `limit`,
 * newest first. `horizonXidSpan` is how many transaction ids the horizon trails the snapshot's
 * newest, which grows while a long write transaction holds the horizon back.
 */
export interface WorkspaceEventLogStore {
  readPage(input: {
    workspaceId: string;
    types: readonly WorkspaceEventType[];
    after: LogPosition | null;
    limit: number;
  }): Promise<{ events: StoredLogEvent[]; horizon: string; horizonXidSpan: number }>;
}
