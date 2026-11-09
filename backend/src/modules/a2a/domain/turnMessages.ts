import type { MessageSource } from "@radioso/conversation-contract";

import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";
import type { A2aTranscriptMessage } from "../contracts/ports.js";

/**
 * Who wrote a message, as the A2A caller sees the conversation: itself, the agent, or a person on
 * the operator side. Both of the last two reach the caller as `ROLE_AGENT`; the converse extension
 * tells them apart.
 */
export type A2aMessageAuthor = "caller" | "agent" | "human";

export interface AuthoredMessage {
  id: string;
  author: A2aMessageAuthor;
  text: string;
}

const CALLER_SOURCE: MessageSource = "customer";
const SYSTEM_SOURCE: MessageSource = "system";

/**
 * Provenance comes from the stored source, not the role: a teammate's reply is stored with the
 * assistant role. System notes are the platform's own and are never shown to the caller.
 */
export const authoredMessages = (messages: readonly A2aTranscriptMessage[]): AuthoredMessage[] =>
  messages.flatMap((message): AuthoredMessage[] => {
    if (message.source === SYSTEM_SOURCE) {
      return [];
    }
    const author: A2aMessageAuthor = message.source === CALLER_SOURCE
      ? "caller"
      : isHumanAuthoredMessageSource(message.source) ? "human" : "agent";
    return [{ id: message.id, author, text: message.text }];
  });

const lastCallerIndex = (messages: readonly AuthoredMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.author === "caller") {
      return index;
    }
  }
  return -1;
};

/**
 * What a person wrote after the caller's previous message, which no reply to the caller carried.
 * With no caller message in view, every person's message in view is unseen.
 */
export const unseenHumanMessages = (messages: readonly AuthoredMessage[]): AuthoredMessage[] =>
  messages.slice(lastCallerIndex(messages) + 1).filter((message) => message.author === "human");

/**
 * What a person wrote after the turn's own message, while the turn ran: replies the turn did not
 * generate. With the turn's message unknown or not in view, every person's message in view counts,
 * so a reply is never dropped.
 */
export const humanRepliesAfter = (messages: readonly AuthoredMessage[], requestMessageId: string | null): AuthoredMessage[] => {
  const requestIndex = requestMessageId ? messages.findIndex((message) => message.id === requestMessageId) : -1;
  return messages.slice(requestIndex + 1).filter((message) => message.author === "human");
};
