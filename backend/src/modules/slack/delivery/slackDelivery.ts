import {
  SlackWebApiError,
  type SlackPostMarkdownMessageInput,
  type SlackPostMessageInput,
  type SlackPostMessageResult,
  type SlackPostTextMessageInput,
} from "../client/slackWebApiClient.js";

export const SLACK_MAX_MESSAGE_TEXT_LENGTH = 40_000;
// chat.postMessage caps `markdown_text` at 12k characters, well under the plain `text` cap.
export const SLACK_MAX_MARKDOWN_TEXT_LENGTH = 12_000;

const slackAuthErrorCodes = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_revoked",
]);

export interface SlackPostMessagePort {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult>;
}

export const slackAuthErrorCode = (error: unknown): string | null =>
  error instanceof SlackWebApiError && slackAuthErrorCodes.has(error.code) ? error.code : null;

/** Log-safe shape of a failed Slack call: the Slack error code and the error class, never the message. */
export const describeSlackError = (error: unknown): { slackErrorCode?: string; errorType: string } =>
  error instanceof SlackWebApiError
    ? { slackErrorCode: error.code, errorType: error.name }
    : { errorType: error instanceof Error ? error.name : typeof error };

const splitSlackMessageText = (
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
  input: SlackPostTextMessageInput,
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

/**
 * Splits markdown so each chunk fits `maxLength` without cutting through a code fence, link,
 * or emphasis span where it can help: the break goes at the last paragraph boundary before
 * the limit, else the last line break, else a hard cut. The separator itself is dropped, so
 * chunks re-join with the boundary they were split on.
 */
export const splitSlackMarkdownText = (
  markdownText: string,
  maxLength = SLACK_MAX_MARKDOWN_TEXT_LENGTH,
): string[] => {
  const chunks: string[] = [];
  let remaining = markdownText;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const paragraphBreak = window.lastIndexOf("\n\n");
    const lineBreak = paragraphBreak > 0 ? -1 : window.lastIndexOf("\n");
    const [cut, separatorLength] = paragraphBreak > 0
      ? [paragraphBreak, 2]
      : lineBreak > 0
        ? [lineBreak, 1]
        : [maxLength, 0];
    chunks.push(remaining.slice(0, cut));
    // A window can end on the first half of a paragraph break; the next chunk never starts blank.
    remaining = remaining.slice(cut + separatorLength).replace(/^\n+/u, "");
  }
  chunks.push(remaining);
  return chunks;
};

/**
 * Post a markdown-formatted message (agent answers), letting Slack render bold, lists, and
 * links. Long answers continue as further messages in the same thread.
 */
export const postSlackMarkdown = async (
  client: SlackPostMessagePort,
  input: SlackPostMarkdownMessageInput,
): Promise<SlackPostMessageResult[]> => {
  const chunks = splitSlackMarkdownText(input.markdownText);
  const results: SlackPostMessageResult[] = [];
  for (const markdownText of chunks) {
    results.push(await client.postMessage({
      ...input,
      markdownText,
    }));
  }
  return results;
};
