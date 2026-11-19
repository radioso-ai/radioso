import type { StoredLogEvent, WorkspaceEvent } from "../../shared/domain/workspaceEventLog.js";

/**
 * An event as the log serves it and a subscription receives it: one envelope for both, the
 * conversation it names first in `data`, then what its type adds.
 */
export const presentWorkspaceEvent = (event: StoredLogEvent): WorkspaceEvent => ({
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
