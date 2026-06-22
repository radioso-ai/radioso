import { SlackWebApiError, type SlackPostMessageInput, type SlackPostMessageResult } from "../client/slackWebApiClient.js";

export const SLACK_MAX_MESSAGE_TEXT_LENGTH = 40_000;

const slackAuthErrorCodes = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_revoked",
]);

export interface SlackPostMessagePort {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult>;
}

export const isSlackAuthError = (error: unknown): boolean =>
  error instanceof SlackWebApiError && slackAuthErrorCodes.has(error.code);

export const slackAuthErrorCode = (error: unknown): string | null =>
  error instanceof SlackWebApiError && slackAuthErrorCodes.has(error.code) ? error.code : null;

export const splitSlackMessageText = (
  text: string,
  maxLength = SLACK_MAX_MESSAGE_TEXT_LENGTH,
): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    chunks.push(text.slice(start, start + maxLength));
  }
  return chunks;
};

export const postSlackText = async (
  client: SlackPostMessagePort,
  input: SlackPostMessageInput,
): Promise<SlackPostMessageResult[]> => {
  const chunks = splitSlackMessageText(input.text);
  const results: SlackPostMessageResult[] = [];
  for (const text of chunks) {
    results.push(await client.postMessage({
      ...input,
      text,
    }));
  }
  return results;
};
