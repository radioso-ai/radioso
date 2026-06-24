import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../../db/repositories/pendingDecisionRepository.js";
import type { OperatorNotification, OperatorNotificationContext, OperatorNotificationSink } from "../../operatorNotifications/public.js";
import type {
  SlackBindingRepositoryPort,
  SlackInstallationRepositoryPort,
  SlackPostOutboxPort,
} from "../public.js";
import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
} from "../outbox/slackPostAction.js";
import { buildDecisionMessage, buildOwnershipMessage } from "./slackBlockKitBuilder.js";

const isPendingApproval = (decision: PendingDecisionRecord, notification: OperatorNotification): boolean =>
  notification.kind === "approval" &&
  decision.status === "pending" &&
  decision.workspaceId === notification.workspaceId &&
  decision.conversationId === notification.conversationId &&
  decision.agentId === notification.agentId;

export class SlackOperatorNotificationSink implements OperatorNotificationSink {
  constructor(private readonly options: {
    installations: Pick<SlackInstallationRepositoryPort, "findByWorkspaceId">;
    bindings: Pick<SlackBindingRepositoryPort, "findByInstallationId">;
    pendingDecisions: Pick<PendingDecisionRepository, "loadByHandle">;
    outbox: SlackPostOutboxPort;
  }) {}

  async deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<void> {
    const installation = await this.options.installations.findByWorkspaceId(notification.workspaceId);
    if (!installation) {
      return;
    }
    const binding = await this.options.bindings.findByInstallationId(installation.id);
    if (!binding?.escalationChannelId) {
      return;
    }
    if (notification.kind === "handoff") {
      const message = buildOwnershipMessage({
        conversationId: notification.conversationId,
        workspaceId: notification.workspaceId,
        state: "ai_owned",
        contextText: notification.reason,
        dashboardPath: notification.dashboardPath,
      });

      await enqueueSlackPostAction(this.options.outbox, {
        workspaceId: notification.workspaceId,
        conversationId: notification.conversationId,
        idempotencyKey: slackPostIdempotencyKey({
          kind: "operator_notification",
          // Scope to this handoff event, not the conversation: a conversation can re-enter human
          // ownership after a hand-back, and each re-escalation must post again. The per-action
          // idempotency key still dedupes a retry of the same handoff.
          sourceId: `handoff:${notification.conversationId}:${context.idempotencyKey ?? context.requestId}`,
        }),
        payload: {
          installationId: installation.id,
          channelId: binding.escalationChannelId,
          kind: "operator_notification",
          conversationRef: notification.conversationId,
          text: message.text,
          blocks: message.blocks,
        },
      });
      return;
    }

    const decision = await this.options.pendingDecisions.loadByHandle(notification.handle);
    if (!decision || !isPendingApproval(decision, notification)) {
      return;
    }

    const message = buildDecisionMessage({
      reason: decision.reason,
      options: decision.options,
      handle: decision.handle,
      contentHash: decision.contentHash,
      agentId: decision.agentId,
      dashboardPath: notification.dashboardPath,
    });

    await enqueueSlackPostAction(this.options.outbox, {
      workspaceId: notification.workspaceId,
      conversationId: notification.conversationId,
      idempotencyKey: slackPostIdempotencyKey({
        kind: "operator_notification",
        sourceId: `decision:${decision.handle}`,
      }),
      payload: {
        installationId: installation.id,
        channelId: binding.escalationChannelId,
        kind: "operator_notification",
        conversationRef: notification.conversationId,
        text: message.text,
        blocks: message.blocks,
      },
    });
  }
}
