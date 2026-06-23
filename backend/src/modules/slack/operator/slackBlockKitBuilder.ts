import type { PendingDecisionOption } from "../../../db/repositories/pendingDecisionRepository.js";

export interface SlackBlockKitMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

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
