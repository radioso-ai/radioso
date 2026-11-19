import { AppError } from "../../shared/domain/errors.js";
import type {
  LogPosition,
  StoredLogEvent,
  WorkspaceEvent,
  WorkspaceEventLogStore,
  WorkspaceEventType,
} from "../../shared/domain/workspaceEventLog.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import { CursorExpiredError, decodeLogCursor, encodeLogCursor, laterPosition } from "./cursor.js";

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

const earlier = (left: Date, right: Date): Date => (left.getTime() <= right.getTime() ? left : right);

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
  constructor(private readonly dependencies: {
    store: WorkspaceEventLogStore;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    clock?: () => Date;
  }) {}

  async list(input: WorkspaceEventListInput): Promise<WorkspaceEventPage> {
    return traceOperation({
      name: "workspace_events.list",
      attributes: {
        "radioso.workspace_id": input.workspaceId,
        "workspace_events.from_cursor": input.after !== null,
        "workspace_events.type_count": input.requestedTypes?.length ?? input.readableTypes.length,
      },
      run: () => this.readPage(input),
      resultAttributes: ({ page, horizonXidSpan }) => ({
        "workspace_events.returned": page.events.length,
        "workspace_events.has_more": page.hasMore,
        // How many transaction ids the read's horizon trailed its snapshot: a long write transaction
        // anywhere on the database holds newer events back, and this grows while it does.
        "workspace_events.horizon_xid_lag": horizonXidSpan,
      }),
    }).then(({ page }) => page);
  }

  private async readPage(input: WorkspaceEventListInput): Promise<{ page: WorkspaceEventPage; horizonXidSpan: number }> {
    const now = this.dependencies.clock?.() ?? new Date();
    const readable = new Set(input.readableTypes);
    const refused = input.requestedTypes?.filter((type) => !readable.has(type)) ?? [];
    if (refused.length > 0) {
      throw new AppError(403, "event_type_not_permitted", "The caller may not read these event types", { types: refused });
    }
    const types = input.requestedTypes ? [...new Set(input.requestedTypes)] : [...input.readableTypes];
    const after = input.after === null ? null : this.decodeCursor(input.after, input.requestedTypes, now);
    const cursorAt = (position: LogPosition, age: Date): string => encodeLogCursor(position, input.requestedTypes, age);

    if (after === null) {
      const { events, horizon, horizonXidSpan } = await this.dependencies.store.readPage({ workspaceId: input.workspaceId, types, after: null, limit: input.limit });
      // The newest events below the horizon: nothing below it follows them.
      const page = { events: events.reverse().map(presentEvent), nextCursor: cursorAt({ tx: horizon, position: "0" }, now), hasMore: false };
      return { page, horizonXidSpan };
    }

    const { events, horizon, horizonXidSpan } = await this.dependencies.store.readPage({ workspaceId: input.workspaceId, types, after, limit: input.limit + 1 });
    const hasMore = events.length > input.limit;
    const pageEvents = events.slice(0, input.limit);
    // A full page ends at its last event, and its cursor ages from when that event happened. A short
    // one read everything below the horizon, so the cursor moves to the horizon, aged from this read,
    // and a narrow filter is not scanned again from the same place.
    const last = pageEvents.at(-1);
    const nextCursor = hasMore && last
      ? cursorAt(positionOf(last), earlier(now, last.occurredAt))
      : cursorAt(laterPosition(after, { tx: horizon, position: "0" }), now);
    return { page: { events: pageEvents.map(presentEvent), nextCursor, hasMore }, horizonXidSpan };
  }

  private decodeCursor(cursor: string, requestedTypes: readonly WorkspaceEventType[] | null, now: Date): LogPosition {
    try {
      return decodeLogCursor(cursor, requestedTypes, now);
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        this.dependencies.metrics?.incrementCounter("workspace_events_cursor_expired_total", {
          help: "Event log reads refused because their cursor was older than the retention window.",
        });
      }
      throw error;
    }
  }
}
