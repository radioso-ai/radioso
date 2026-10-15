import { z } from "zod";

import {
  BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobRequest,
} from "../../../../shared/background-jobs/index.js";
import type {
  SlackAppHomeOpenedEvent,
  SlackAppMentionEvent,
  SlackChannelMessageEvent,
  SlackMessageHandler,
  SlackMessageImEvent,
} from "./slackMessageHandler.js";
import type { SlackPersistencePort } from "./slackPersistence.js";

// --- Parsing: a raw Slack event payload into the typed shape the job carries and the message
// handler dispatches on. Pure and side-effect free, so the webhook can build a job payload
// before anything is written, and the schema below can validate the same shape on enqueue and
// again on claim.

export const isSlackPayloadObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readSlackPayloadString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// Only a fresh human post is a question. Slack marks everything else with a subtype
// (message_changed, message_deleted, channel_join, bot_message, thread_broadcast, ...);
// the one subtype that is still a person asking is a message posted with an attachment.
const isHumanPost = (event: Record<string, unknown>): boolean =>
  event.subtype === undefined || event.subtype === "file_share";

// A direct message; `thread_ts` marks a follow-up inside an agent-pane session.
const parseMessageImEvent = (event: unknown): SlackMessageImEvent | null => {
  if (!isSlackPayloadObject(event)) {
    return null;
  }
  if (event.type !== "message" || event.channel_type !== "im" || !isHumanPost(event)) {
    return null;
  }
  const channel = readSlackPayloadString(event.channel);
  const user = readSlackPayloadString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readSlackPayloadString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  const threadTs = readSlackPayloadString(event.thread_ts);
  const botId = readSlackPayloadString(event.bot_id);
  return {
    type: "message",
    channel_type: "im",
    channel,
    user,
    text,
    ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(botId ? { bot_id: botId } : {}),
  };
};

const parseAppHomeOpenedEvent = (event: unknown): SlackAppHomeOpenedEvent | null => {
  if (!isSlackPayloadObject(event) || event.type !== "app_home_opened") {
    return null;
  }
  const user = readSlackPayloadString(event.user);
  const channel = readSlackPayloadString(event.channel);
  const tab = event.tab === "messages" || event.tab === "home" ? event.tab : null;
  if (!user || !channel || !tab) {
    return null;
  }
  return { type: "app_home_opened", user, channel, tab };
};

// Un-mentioned traffic in public (`channel`) and private (`group`) channels.
const parseChannelMessageEvent = (event: unknown): SlackChannelMessageEvent | null => {
  if (!isSlackPayloadObject(event) || event.type !== "message") {
    return null;
  }
  const channelType = event.channel_type === "channel" || event.channel_type === "group"
    ? event.channel_type
    : null;
  if (!channelType || !isHumanPost(event)) {
    return null;
  }
  const channel = readSlackPayloadString(event.channel);
  const user = readSlackPayloadString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readSlackPayloadString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  const threadTs = readSlackPayloadString(event.thread_ts);
  const botId = readSlackPayloadString(event.bot_id);
  return {
    type: "message",
    channel_type: channelType,
    channel,
    user,
    text,
    ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(botId ? { bot_id: botId } : {}),
  };
};

const parseAppMentionEvent = (event: unknown): SlackAppMentionEvent | null => {
  if (!isSlackPayloadObject(event) || event.type !== "app_mention") {
    return null;
  }
  const channel = readSlackPayloadString(event.channel);
  const user = readSlackPayloadString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readSlackPayloadString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  return {
    type: "app_mention",
    channel,
    user,
    text,
    ts,
    ...(readSlackPayloadString(event.thread_ts) ? { thread_ts: readSlackPayloadString(event.thread_ts)! } : {}),
    ...(readSlackPayloadString(event.bot_id) ? { bot_id: readSlackPayloadString(event.bot_id)! } : {}),
  };
};

type ParsedSlackInboundEvent =
  | { kind: "im"; event: SlackMessageImEvent }
  | { kind: "mention"; event: SlackAppMentionEvent }
  | { kind: "channel"; event: SlackChannelMessageEvent }
  | { kind: "app_home_opened"; event: SlackAppHomeOpenedEvent };

export const parseSlackInboundEvent = (event: unknown): ParsedSlackInboundEvent | null => {
  const messageImEvent = parseMessageImEvent(event);
  if (messageImEvent) {
    return { kind: "im", event: messageImEvent };
  }
  const appMentionEvent = parseAppMentionEvent(event);
  if (appMentionEvent) {
    return { kind: "mention", event: appMentionEvent };
  }
  const channelMessageEvent = parseChannelMessageEvent(event);
  if (channelMessageEvent) {
    return { kind: "channel", event: channelMessageEvent };
  }
  const appHomeOpenedEvent = parseAppHomeOpenedEvent(event);
  if (appHomeOpenedEvent) {
    return { kind: "app_home_opened", event: appHomeOpenedEvent };
  }
  return null;
};

// --- Job: the durable record of one inbound event, carried from the webhook (which only
// verifies, dedupes, and enqueues) to the worker (which runs the existing message dispatch).

const slackMessageEventFields = {
  channel: z.string().min(1),
  user: z.string().min(1),
  text: z.string(),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
};

const messageImEventSchema = z.object({
  type: z.literal("message"),
  channel_type: z.literal("im"),
  ...slackMessageEventFields,
});

const appMentionEventSchema = z.object({
  type: z.literal("app_mention"),
  ...slackMessageEventFields,
});

const channelMessageEventSchema = z.object({
  type: z.literal("message"),
  channel_type: z.enum(["channel", "group"]),
  ...slackMessageEventFields,
});

const appHomeOpenedEventSchema = z.object({
  type: z.literal("app_home_opened"),
  user: z.string().min(1),
  channel: z.string().min(1),
  tab: z.enum(["messages", "home"]),
});

const slackInboundEventJobPayloadSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  inbound: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("im"), event: messageImEventSchema }),
    z.object({ kind: z.literal("mention"), event: appMentionEventSchema }),
    z.object({ kind: z.literal("channel"), event: channelMessageEventSchema }),
    z.object({ kind: z.literal("app_home_opened"), event: appHomeOpenedEventSchema }),
  ]),
});

export type SlackInboundEventJobPayload = z.infer<typeof slackInboundEventJobPayloadSchema>;

/**
 * One Slack event, dispatched in the worker instead of a detached promise after the webhook's
 * ack. `onDuplicateKey: "ignore"` makes this one-shot: redelivery dedupe stays where it already is
 * (`slack_inbound_events`/`createInboundEvent`), so a duplicate enqueue while the job is live is
 * simply dropped rather than re-running or re-queuing it. Four attempts with a 5s-doubling backoff
 * mirror the retry budget the old in-process retries used (1s/5s/30s).
 *
 * `timeoutSeconds` is pinned to the port's maximum (`BACKGROUND_JOB_MAX_TIMEOUT_SECONDS`), not a
 * value sized to a typical turn: neither `ChatAnswerPort.answer` nor `SlackMessageHandler`'s
 * dispatch methods accept the handler's `AbortSignal`, so a timeout here does not stop the
 * handler — it only tells the runtime to retry early while the original run keeps going. A slow
 * model call or skill webhook past a tighter deadline would then post its reply twice: once from
 * the still-running original attempt, once from the retry. The old in-process code had no
 * deadline at all, so this keeps that behaviour rather than regressing it, while still bounding a
 * genuinely wedged worker. `leaseSeconds` sits above the timeout (so a run that legitimately
 * takes the full deadline never loses its claim mid-flight) and below the document worker's own
 * 300s request deadline (`infra/terraform/compute.tf`), so a retry only fires once the worker that
 * held the job is actually gone.
 */
export const SLACK_INBOUND_EVENT_JOB = defineBackgroundJob({
  kind: "slack.inbound_event",
  payload: slackInboundEventJobPayloadSchema,
  onDuplicateKey: "ignore",
  maxAttempts: 4,
  timeoutSeconds: BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
  leaseSeconds: 270,
  retryBaseDelaySeconds: 5,
});

export const slackInboundEventJobRequest = (input: SlackInboundEventJobPayload): BackgroundJobRequest =>
  backgroundJobRequest(SLACK_INBOUND_EVENT_JOB, input, { idempotencyKey: input.eventId });

interface SlackInboundEventJobLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

type SlackInboundMessageHandler = Pick<
  SlackMessageHandler,
  "handleMessageIm" | "handleAppMention" | "handleChannelMessage" | "handleAppHomeOpened"
>;

const dispatchSlackInboundEvent = (
  messageHandler: SlackInboundMessageHandler,
  payload: SlackInboundEventJobPayload,
): Promise<void> => {
  const envelope = { eventId: payload.eventId, teamId: payload.teamId };
  switch (payload.inbound.kind) {
    case "im":
      return messageHandler.handleMessageIm({ ...envelope, event: payload.inbound.event });
    case "mention":
      return messageHandler.handleAppMention({ ...envelope, event: payload.inbound.event });
    case "channel":
      return messageHandler.handleChannelMessage({ ...envelope, event: payload.inbound.event });
    case "app_home_opened":
      return messageHandler.handleAppHomeOpened({ ...envelope, event: payload.inbound.event });
  }
};

/**
 * Runs the existing Slack message dispatch for one job attempt. Most skip/processed transitions
 * already happen inside the message handler itself; this wrapper's own job is the one transition
 * the handler cannot make on its own — recognising the port's *final* attempt (the one about to
 * be dead-lettered) and marking the inbound event `failed` there, instead of on every retry.
 */
export const createSlackInboundEventJobHandler = (
  messageHandler: SlackInboundMessageHandler,
  persistence: Pick<SlackPersistencePort, "markInboundEventStatus">,
  logger: SlackInboundEventJobLogger,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(SLACK_INBOUND_EVENT_JOB, async (payload, context) => {
    try {
      await dispatchSlackInboundEvent(messageHandler, payload);
    } catch (error) {
      if (context.attempt >= SLACK_INBOUND_EVENT_JOB.policy.maxAttempts) {
        try {
          await persistence.markInboundEventStatus(payload.eventId, "failed");
        } catch (statusError) {
          logger.warn(
            {
              teamId: payload.teamId,
              eventId: payload.eventId,
              errorType: statusError instanceof Error ? statusError.name : typeof statusError,
            },
            "Slack inbound event failure status update failed",
          );
        }
      }
      throw error;
    }
  });
