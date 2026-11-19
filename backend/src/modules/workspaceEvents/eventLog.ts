import { AppError } from "../../shared/domain/errors.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import type { WorkspaceEvent, WorkspaceEventType } from "../../shared/domain/workspaceEvents.js";
import { decodeLogCursor, encodeLogCursor, laterPosition, type LogPosition } from "./cursor.js";

/** One stored event as the store reads it, with its place in the log. */
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

/** Where the log reads from: one page below the snapshot horizon, and that horizon. */
export interface WorkspaceEventLogStore {
  readPage(input: {
    workspaceId: string;
    types: readonly WorkspaceEventType[];
    after: LogPosition | null;
    limit: number;
  }): Promise<{ events: StoredLogEvent[]; horizon: string }>;
}

interface WorkspaceEventPage {
  events: WorkspaceEvent[];
  /** Pass back as `after` for the events that follow. Always present, so a client keeps its place. */
  nextCursor: string;
  /** True when more events follow `nextCursor` right now. */
  hasMore: boolean;
}

/** An event as served: the conversation it names first, then what its type adds. */
const presentEvent = (event: StoredLogEvent): WorkspaceEvent => ({
  id: event.id,
  type: event.type,
  version: event.version,
  occurredAt: event.occurredAt.toISOString(),
  workspaceId: event.workspaceId,
  data: {
    conversationId: event.conversationId,
    agentId: event.agentId,
    channel: event.channel,
    callerKind: event.callerKind,
    visitorId: event.visitorId,
    ...event.data,
  },
});

const positionOf = (event: StoredLogEvent): LogPosition => ({ tx: event.tx, position: event.position });

interface WorkspaceEventListInput {
  workspaceId: string;
  readableTypes: readonly WorkspaceEventType[];
  requestedTypes: readonly WorkspaceEventType[] | null;
  after: string | null;
  limit: number;
}

/**
 * Lists a workspace's events by cursor (#1851). Without `after` it serves the newest events, oldest
 * first, and a cursor at the log's end: a client's starting point. With `after` it serves what
 * followed, in commit-safe order: an event whose transaction is still running is held back until it
 * ends, never passed. The caller resolves which types it may read; asking for any other is refused.
 */
export class WorkspaceEventLog {
  constructor(private readonly dependencies: { store: WorkspaceEventLogStore; clock?: () => Date }) {}

  async list(input: WorkspaceEventListInput): Promise<WorkspaceEventPage> {
    return traceOperation({
      name: "workspace_events.list",
      attributes: {
        "radioso.workspace_id": input.workspaceId,
        "workspace_events.from_cursor": input.after !== null,
        "workspace_events.type_count": input.requestedTypes?.length ?? input.readableTypes.length,
      },
      run: () => this.readPage(input),
      resultAttributes: (page) => ({ "workspace_events.returned": page.events.length, "workspace_events.has_more": page.hasMore }),
    });
  }

  private async readPage(input: WorkspaceEventListInput): Promise<WorkspaceEventPage> {
    const now = this.dependencies.clock?.() ?? new Date();
    const readable = new Set(input.readableTypes);
    const refused = input.requestedTypes?.filter((type) => !readable.has(type)) ?? [];
    if (refused.length > 0) {
      throw new AppError(403, "event_type_not_permitted", "The caller may not read these event types", { types: refused });
    }
    const types = input.requestedTypes ? [...new Set(input.requestedTypes)] : [...input.readableTypes];
    const after = input.after === null ? null : decodeLogCursor(input.after, input.requestedTypes, now);
    const cursorAt = (position: LogPosition): string => encodeLogCursor(position, input.requestedTypes, now);

    if (after === null) {
      const { events, horizon } = await this.dependencies.store.readPage({ workspaceId: input.workspaceId, types, after: null, limit: input.limit });
      // The newest events below the horizon: nothing below it follows them.
      return { events: events.reverse().map(presentEvent), nextCursor: cursorAt({ tx: horizon, position: "0" }), hasMore: false };
    }

    const { events, horizon } = await this.dependencies.store.readPage({ workspaceId: input.workspaceId, types, after, limit: input.limit + 1 });
    const hasMore = events.length > input.limit;
    const page = events.slice(0, input.limit);
    // A full page ends at its last event. A short one read everything below the horizon, so the
    // cursor moves to the horizon and a narrow filter is not scanned again from the same place.
    const next = hasMore ? positionOf(page.at(-1)!) : laterPosition(after, { tx: horizon, position: "0" });
    return { events: page.map(presentEvent), nextCursor: cursorAt(next), hasMore };
  }
}
