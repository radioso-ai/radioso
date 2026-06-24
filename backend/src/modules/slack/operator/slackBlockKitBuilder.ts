import type { PendingDecisionOption } from "../../../db/repositories/pendingDecisionRepository.js";

export interface SlackBlockKitMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export const OWNERSHIP_REPLY_BLOCK_ID = "ownership_reply_message";
export const OWNERSHIP_REPLY_ACTION_ID = "ownership_reply_text";

const SECTION_TEXT_LIMIT = 3_000;
const BUTTON_LABEL_LIMIT = 75;
const PLAIN_TEXT_LABEL_LIMIT = 2_000;
const MODAL_TITLE_LIMIT = 24;
const ACTIONS_ELEMENTS_LIMIT = 25;
const ELLIPSIS = "…";

const clampText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, limit);
  }
  return `${text.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
};

const clampSectionText = (text: string): string => clampText(text, SECTION_TEXT_LIMIT);
const clampButtonLabel = (text: string): string => clampText(text, BUTTON_LABEL_LIMIT);
const clampPlainTextLabel = (text: string): string => clampText(text, PLAIN_TEXT_LABEL_LIMIT);
const clampModalTitle = (text: string): string => clampText(text, MODAL_TITLE_LIMIT);

const plainText = (text: string): Record<string, unknown> => ({
  type: "plain_text",
  text: clampPlainTextLabel(text),
  emoji: true,
});

const mrkdwnSection = (text: string): Record<string, unknown> => ({
  type: "section",
  text: {
    type: "mrkdwn",
    text: clampSectionText(text),
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
  const visibleOptions = input.options.slice(0, ACTIONS_ELEMENTS_LIMIT);
  const hiddenOptionCount = input.options.length - visibleOptions.length;
  return {
    text: clampSectionText(prompt),
    blocks: [
      mrkdwnSection(prompt),
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `<${input.dashboardPath}|${input.dashboardPath}>`,
        }],
      },
      ...(hiddenOptionCount > 0
        ? [{
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `<${input.dashboardPath}|${input.dashboardPath}> ${ELLIPSIS}`,
            }],
          }]
        : []),
      {
        type: "actions",
        elements: visibleOptions.map((option) => ({
          type: "button",
          action_id: "decision_resolve",
          text: plainText(clampButtonLabel(option.label)),
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
  const outcome = `✅ ${clampButtonLabel(input.chosenLabel)} — chosen by ${actor}${input.resumed ? "; resumed" : ""}`;
  return {
    text: clampSectionText(outcome),
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
    text: clampSectionText(contextText),
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
  title: plainText(clampModalTitle("Reply")),
  submit: plainText(clampModalTitle("Send")),
  close: plainText(clampModalTitle("Cancel")),
  blocks: [
    {
      type: "input",
      block_id: OWNERSHIP_REPLY_BLOCK_ID,
      element: {
        type: "plain_text_input",
        action_id: OWNERSHIP_REPLY_ACTION_ID,
        multiline: true,
      },
      label: plainText(clampPlainTextLabel("Message")),
    },
  ],
});
