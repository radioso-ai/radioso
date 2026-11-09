import type { A2aTranscriptPage, A2aTranscriptPort } from "../contracts/ports.js";

/** Messages one read asks for at a time. */
const PAGE_SIZE = 100;

/**
 * The pages one read walks past a cursor before it skips to the conversation's latest page. A
 * thousand messages past a caller's view is far beyond any conversation a calling agent holds.
 */
const MAX_PAGES = 10;

/**
 * Everything past `cursor`, oldest first, read page by page to the end of the conversation, so the
 * newest message, and the cursor after it, are always in the result. A read that would take more
 * than `MAX_PAGES` pages ends on the latest page instead: what a task reports is the newest message,
 * and its history is a range of message ids, so the messages skipped are still in it. With no
 * cursor the read is the latest page alone.
 */
export const readToEnd = async (
  transcript: Pick<A2aTranscriptPort, "readAfter">,
  input: { workspaceId: string; conversationId: string; cursor: string | null },
): Promise<A2aTranscriptPage> => {
  let page = await transcript.readAfter({ ...input, limit: PAGE_SIZE });
  if (input.cursor === null) {
    return page;
  }
  const messages = [...page.messages];
  for (let pages = 1; page.messages.length === PAGE_SIZE; pages += 1) {
    if (pages === MAX_PAGES) {
      return transcript.readAfter({ ...input, cursor: null, limit: PAGE_SIZE });
    }
    page = await transcript.readAfter({ ...input, cursor: page.cursor, limit: PAGE_SIZE });
    messages.push(...page.messages);
  }
  return { messages, cursor: page.cursor, ownership: page.ownership };
};
