import { createHash } from "node:crypto";

import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
  type SlackPostOutboxPort,
} from "../outbox/slackPostAction.js";
import type { SlackInstallationRepositoryPort } from "../install/slackInstallationService.js";
import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyDeliveryInput,
} from "../../customerReplyDelivery/public.js";

const replySourceId = (input: CustomerReplyDeliveryInput): string => {
  if (input.message.id) {
    return `${input.conversation.id}:${input.message.id}`;
  }
  const digest = createHash("sha256").update(input.message.content).digest("hex");
  return `${input.conversation.id}:content:${digest}`;
};

export class SlackCustomerReplyDeliverer implements CustomerChannelReplyDeliverer {
  constructor(private readonly dependencies: {
    installations: Pick<SlackInstallationRepositoryPort, "findByWorkspaceId">;
    outbox: SlackPostOutboxPort;
  }) {}

  async deliver(input: CustomerReplyDeliveryInput): Promise<void> {
    const channelContext = input.conversation.channelContext;
    if (channelContext?.provider !== "slack") {
      return;
    }
    const installation = await this.dependencies.installations.findByWorkspaceId(input.conversation.workspaceId);
    if (!installation) {
      return;
    }
    await enqueueSlackPostAction(this.dependencies.outbox, {
      workspaceId: input.conversation.workspaceId,
      conversationId: input.conversation.id,
      idempotencyKey: slackPostIdempotencyKey({
        kind: "human_reply",
        sourceId: replySourceId(input),
      }),
      payload: {
        installationId: installation.id,
        channelId: channelContext.channel.id,
        text: input.message.content,
        ...(channelContext.threadTs ? { threadTs: channelContext.threadTs } : {}),
        conversationRef: input.conversation.id,
        kind: "human_reply",
      },
    });
  }
}
