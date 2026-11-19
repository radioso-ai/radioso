import { isConversationOwnershipReasonCode } from "../../shared/domain/conversationOwnershipReasons.js";
import type { WorkspaceEventRecorder } from "../../shared/domain/workspaceEventLog.js";
import type { ConversationActivityRecorder } from "./contracts/index.js";

/**
 * Records, beside each activity, the workspace event automations follow for it, in the same
 * transaction: a requested handoff becomes `handoff.requested`. Every path that hands a conversation
 * to a person records the `handoff_requested` activity, so this is the one place the event is
 * written, whichever path handed off. The event publishes listed reason codes only; every writer
 * hands off with one (`tests/unit/workspaceEventLog/handoff-reason-codes.test.ts`).
 */
export const publishingWorkspaceEvents = (
  activity: ConversationActivityRecorder,
  events: WorkspaceEventRecorder,
): ConversationActivityRecorder => ({
  record: async (db, event) => {
    await activity.record(db, event);
    if (event.kind === "handoff_requested" && isConversationOwnershipReasonCode(event.detail.reason)) {
      await events.record(db, {
        type: "handoff.requested",
        workspaceId: event.workspaceId,
        conversationId: event.conversationId,
        detail: { reason: event.detail.reason },
      });
    }
  },
});
