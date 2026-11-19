import type { WorkspaceEventRecorder } from "../../shared/domain/workspaceEvents.js";
import type { ConversationActivityRecorder } from "./contracts/index.js";

/**
 * Records, beside each activity, the workspace event automations follow for it, in the same
 * transaction: a requested handoff becomes `handoff.requested`. Every path that hands a conversation
 * to a person records the `handoff_requested` activity, so this is the one place the event is
 * written, whichever path handed off.
 */
export const publishingWorkspaceEvents = (
  activity: ConversationActivityRecorder,
  events: WorkspaceEventRecorder,
): ConversationActivityRecorder => ({
  record: async (db, event) => {
    await activity.record(db, event);
    if (event.kind === "handoff_requested") {
      await events.record(db, {
        type: "handoff.requested",
        workspaceId: event.workspaceId,
        conversationId: event.conversationId,
        detail: { reason: event.detail.reason },
      });
    }
  },
});
