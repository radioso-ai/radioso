import type { SlackBindingRespondMode } from "../../../slack/public.js";

export type SlackChannelMessageSkipReason =
  // A reply inside a thread Radioso never joined: the bot stays out unless it is mentioned.
  | "thread_not_owned"
  // A top-level message in a channel whose binding waits for an @mention.
  | "mention_only";

type SlackChannelMessageDisposition =
  | { kind: "answer"; threadTs: string }
  | { kind: "skip"; reason: SlackChannelMessageSkipReason };

interface ChannelMessageDispositionInput {
  ts: string;
  threadTs: string | undefined;
  // Whether a conversation link already exists for the thread this message sits in.
  hasOwnedThread: boolean;
  binding: {
    channelId: string | null;
    respondMode: SlackBindingRespondMode;
  };
}

/**
 * Decide whether an un-mentioned channel message gets an answer, and in which thread.
 *
 * - A thread reply is answered only when Radioso already owns that thread (continuity); the
 *   respond mode never makes the bot join threads it was not brought into.
 * - A top-level message is answered, in a new thread under it, only when the channel has an
 *   explicit binding set to `every_message`. The installation default binding (channelId null)
 *   never answers un-mentioned top-level traffic, whatever it says.
 */
export const resolveChannelMessageDisposition = (
  input: ChannelMessageDispositionInput,
): SlackChannelMessageDisposition => {
  const { ts, threadTs } = input;
  // Slack marks a thread parent with thread_ts === ts; only a differing thread_ts is a reply.
  if (threadTs !== undefined && threadTs !== ts) {
    return input.hasOwnedThread
      ? { kind: "answer", threadTs }
      : { kind: "skip", reason: "thread_not_owned" };
  }
  const answersEveryMessage = input.binding.channelId !== null && input.binding.respondMode === "every_message";
  return answersEveryMessage
    ? { kind: "answer", threadTs: ts }
    : { kind: "skip", reason: "mention_only" };
};
