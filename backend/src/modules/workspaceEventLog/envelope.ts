import { isDocumentEventType, type StoredLogEvent, type WorkspaceEvent } from "../../shared/domain/workspaceEventLog.js";

/**
 * An event as the log serves it and a subscription receives it: one envelope for both. A
 * conversation event's `data` names the conversation first, then what its type adds; a document
 * event's `data` was written whole, with the document it names.
 */
export const presentWorkspaceEvent = (event: StoredLogEvent): WorkspaceEvent => ({
  id: event.id,
  type: event.type,
  version: event.version,
  occurredAt: event.occurredAt.toISOString(),
  workspaceId: event.workspaceId,
  data: isDocumentEventType(event.type)
    ? event.data
    : {
      conversationId: event.conversationId,
      agentId: event.agentId,
      channel: event.channel,
      callerKind: event.callerKind,
      visitorId: event.visitorId,
      ...event.data,
    },
});
