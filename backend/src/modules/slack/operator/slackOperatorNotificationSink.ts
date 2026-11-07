import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../../db/repositories/pendingDecisionRepository.js";
import {
  formatRoutineEndingNotification,
  type OperatorNotification,
  type OperatorNotificationContext,
  type OperatorNotificationSink,
  type OperatorNotificationSinkOutcome,
} from "../../operatorNotifications/public.js";
import {
  resolveConversationLink,
  type ConversationLinkResolver,
} from "../../../shared/domain/conversationLinkResolver.js";
import type { SlackPostOutboxPort } from "../public.js";
import { resolveSlackEscalationChannel, type SlackEscalationChannelPorts } from "./slackEscalationChannel.js";
import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
} from "../outbox/slackPostAction.js";
import { buildDecisionMessage, buildOwnershipMessage, escapeMrkdwn } from "./slackBlockKitBuilder.js";

const isPendingApproval = (decision: PendingDecisionRecord, notification: OperatorNotification): boolean =>
  notification.kind === "approval" &&
  decision.status === "pending" &&
  decision.workspaceId === notification.workspaceId &&
  decision.conversationId === notification.conversationId &&
  decision.agentId === notification.agentId;

export class SlackOperatorNotificationSink implements OperatorNotificationSink {
  constructor(private readonly options: SlackEscalationChannelPorts & {
    pendingDecisions: Pick<PendingDecisionRepository, "loadByHandle">;
    outbox: SlackPostOutboxPort;
    conversationLinks?: ConversationLinkResolver;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
  }) {}

  async deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<OperatorNotificationSinkOutcome> {
    const channel = await resolveSlackEscalationChannel(this.options, notification.workspaceId);
    if (!channel.found) {
      return { disposition: "skipped", reason: channel.reason };
    }
    const { accountId, installationId, channelId } = channel;
    if (notification.kind !== "approval") {
      // Slack has no separate subject field, so the post's text leads with the formatter's
      // subject line (authored, or its per-kind default) before the headline and the rest of
      // the formatted lines — the same content the email splits across Subject: and body.
      const formatted = formatRoutineEndingNotification(notification);
      const noticeText = [formatted.subject, ...formatted.lines].join("\n").trim();
      const message = buildOwnershipMessage({
        conversationId: notification.conversationId,
        workspaceId: notification.workspaceId,
        state: "ai_owned",
        // The notice is plain text on every transport, and visitors supply much of it (collected
        // values, the entry page). Escaped whole, authored text included, it posts literally:
        // no value can mention the channel or forge a link, and the author's text reads the
        // same here as in the email.
        contextText: escapeMrkdwn(noticeText),
        dashboardUrl: await this.resolveDashboardUrl(notification),
      });

      await enqueueSlackPostAction(this.options.outbox, {
        workspaceId: notification.workspaceId,
        accountId,
        conversationId: notification.conversationId,
        idempotencyKey: slackPostIdempotencyKey({
          kind: "operator_notification",
          // Scope to this notice, not the conversation: a conversation can re-enter human
          // ownership after a hand-back, and each re-escalation must post again. The per-action
          // idempotency key still dedupes a retry of the same notice.
          sourceId: `${notification.kind}:${notification.conversationId}:${context.idempotencyKey ?? context.requestId}`,
        }),
        payload: {
          installationId,
          channelId,
          kind: "operator_notification",
          conversationRef: notification.conversationId,
          text: message.text,
          blocks: message.blocks,
        },
      });
      return { disposition: "delivered" };
    }

    const decision = await this.options.pendingDecisions.loadByHandle(notification.handle);
    if (!decision || !isPendingApproval(decision, notification)) {
      return { disposition: "skipped", reason: "slack_approval_not_pending" };
    }

    const message = buildDecisionMessage({
      reason: decision.reason,
      options: decision.options,
      handle: decision.handle,
      contentHash: decision.contentHash,
      agentId: decision.agentId,
      dashboardUrl: await this.resolveDashboardUrl(notification),
    });

    await enqueueSlackPostAction(this.options.outbox, {
      workspaceId: notification.workspaceId,
      accountId,
      conversationId: notification.conversationId,
      idempotencyKey: slackPostIdempotencyKey({
        kind: "operator_notification",
        sourceId: `decision:${decision.handle}`,
      }),
      payload: {
        installationId,
        channelId,
        kind: "operator_notification",
        conversationRef: notification.conversationId,
        text: message.text,
        blocks: message.blocks,
      },
    });
    return { disposition: "delivered" };
  }

  private resolveDashboardUrl(notification: OperatorNotification): Promise<string | null> {
    return resolveConversationLink(
      this.options.conversationLinks,
      { workspaceId: notification.workspaceId, conversationId: notification.conversationId },
      this.options.logger,
    );
  }
}
