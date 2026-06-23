import type { PendingDecisionOption } from "../../../db/repositories/pendingDecisionRepository.js";

export interface SlackBlockKitMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export const OWNERSHIP_REPLY_BLOCK_ID = "ownership_reply_message";
export const OWNERSHIP_REPLY_ACTION_ID = "ownership_reply_text";

const plainText = (text: string): Record<string, unknown> => ({
  type: "plain_text",
  text,
  emoji: true,
});

const mrkdwnSection = (text: string): Record<string, unknown> => ({
  type: "section",
  text: {
    type: "mrkdwn",
    text,
  },
});

const encodeDecisionValue = (input: {
  handle: string;
  optionId: string;
  contentHash: string;
  agentId: string;
}): string => {
  const value = JSON.stringify(input);
  if (value.length > 2_000) {
    throw new Error("slack_decision_action_value_too_large");
  }
  return value;
};

const encodeOwnershipValue = (input: Record<string, string | number>): string => {
  const value = JSON.stringify(input);
  if (value.length > 2_000) {
    throw new Error("slack_ownership_action_value_too_large");
  }
  return value;
};

export const buildDecisionMessage = (input: {
  reason: string | null;
  options: PendingDecisionOption[];
  handle: string;
  contentHash: string;
  agentId: string;
  dashboardPath: string;
}): SlackBlockKitMessage => {
  const prompt = input.reason?.trim() || input.handle;
  return {
    text: prompt,
    blocks: [
      mrkdwnSection(prompt),
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `<${input.dashboardPath}|${input.dashboardPath}>`,
        }],
      },
      {
        type: "actions",
        elements: input.options.map((option) => ({
          type: "button",
          action_id: "decision_resolve",
          text: plainText(option.label),
          value: encodeDecisionValue({
            handle: input.handle,
            optionId: option.id,
            contentHash: input.contentHash,
            agentId: input.agentId,
          }),
        })),
      },
    ],
  };
};

export const buildResolvedDecisionMessage = (input: {
  reason: string | null;
  chosenLabel: string;
  operatorName: string | null;
  resumed: boolean;
}): SlackBlockKitMessage => {
  const prompt = input.reason?.trim() || input.chosenLabel;
  const actor = input.operatorName?.trim() || "operator";
  const outcome = `✅ ${input.chosenLabel} — chosen by ${actor}${input.resumed ? "; resumed" : ""}`;
  return {
    text: outcome,
    blocks: [
      mrkdwnSection(prompt),
      mrkdwnSection(outcome),
    ],
  };
};

export const buildOwnershipMessage = (input: {
  conversationId: string;
  workspaceId: string;
  state: "ai_owned" | "human_owned";
  contextText: string;
  dashboardPath: string;
  ownerName?: string | null;
  version?: number;
}): SlackBlockKitMessage => {
  const contextText = input.contextText.trim() || input.conversationId;
  const dashboardLink = `<${input.dashboardPath}|${input.dashboardPath}>`;
  if (input.state === "human_owned") {
    const ownerName = input.ownerName?.trim() || "Operator";
    const version = input.version ?? 0;
    const status = `Handled by ${ownerName}`;
    return {
      text: status,
      blocks: [
        mrkdwnSection(contextText),
        mrkdwnSection(status),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "ownership_talk",
              text: plainText("Talk to customer"),
              value: encodeOwnershipValue({
                conversationId: input.conversationId,
                workspaceId: input.workspaceId,
                version,
              }),
            },
            {
              type: "button",
              action_id: "ownership_handback",
              text: plainText("Hand back to AI"),
              value: encodeOwnershipValue({
                conversationId: input.conversationId,
                version,
              }),
            },
          ],
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: dashboardLink }],
        },
      ],
    };
  }

  return {
    text: contextText,
    blocks: [
      mrkdwnSection(contextText),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: dashboardLink }],
      },
      {
        type: "actions",
        elements: [{
          type: "button",
          action_id: "ownership_takeover",
          text: plainText("Take over"),
          value: encodeOwnershipValue({
            conversationId: input.conversationId,
            workspaceId: input.workspaceId,
          }),
        }],
      },
    ],
  };
};

export const buildReplyModal = (input: {
  conversationId: string;
  workspaceId: string;
  version: number;
}): Record<string, unknown> => ({
  type: "modal",
  callback_id: "ownership_reply",
  private_metadata: JSON.stringify({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    version: input.version,
  }),
  title: plainText("Reply"),
  submit: plainText("Send"),
  close: plainText("Cancel"),
  blocks: [
    {
      type: "input",
      block_id: OWNERSHIP_REPLY_BLOCK_ID,
      element: {
        type: "plain_text_input",
        action_id: OWNERSHIP_REPLY_ACTION_ID,
        multiline: true,
      },
      label: plainText("Message"),
    },
  ],
});
