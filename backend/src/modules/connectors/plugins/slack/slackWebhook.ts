import { Router, type Request } from "express";

import type { ConnectorLogger } from "@radioso/connector-api";

import { isValidSlackSignature, type SlackInstallationRepositoryPort } from "../../../slack/public.js";
import type {
  SlackAppHomeOpenedEvent,
  SlackAppMentionEvent,
  SlackChannelMessageEvent,
  SlackMessageHandler,
  SlackMessageImEvent,
} from "./slackMessageHandler.js";
import type { SlackPersistencePort } from "./slackPersistence.js";

interface SlackWebhookRouterOptions {
  logger: ConnectorLogger;
  signingSecret: string;
  installations: SlackInstallationRepositoryPort;
  persistence: Pick<SlackPersistencePort, "createInboundEvent" | "markInboundEventStatus">;
  messageHandler: Pick<
    SlackMessageHandler,
    "handleAppMention" | "handleMessageIm" | "handleChannelMessage" | "handleAppHomeOpened" | "isBotLoop"
  >;
  now?: () => number;
  processingRetryDelaysMs?: readonly number[];
}

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

const DEFAULT_PROCESSING_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// A direct message; `thread_ts` marks an agent-pane session message.
const parseMessageImEvent = (event: unknown): SlackMessageImEvent | null => {
  if (!isObject(event)) {
    return null;
  }
  if (event.type !== "message" || event.channel_type !== "im") {
    return null;
  }
  const channel = readString(event.channel);
  const user = readString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  const threadTs = readString(event.thread_ts);
  const botId = readString(event.bot_id);
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
  if (!isObject(event) || event.type !== "app_home_opened") {
    return null;
  }
  const user = readString(event.user);
  const channel = readString(event.channel);
  const tab = event.tab === "messages" || event.tab === "home" ? event.tab : null;
  if (!user || !channel || !tab) {
    return null;
  }
  return { type: "app_home_opened", user, channel, tab };
};

// Un-mentioned traffic in public (`channel`) and private (`group`) channels. Only a fresh
// human post qualifies: any subtype (message_changed, message_deleted, channel_join,
// bot_message, thread_broadcast, ...) is not a new question and is dropped here.
const parseChannelMessageEvent = (event: unknown): SlackChannelMessageEvent | null => {
  if (!isObject(event) || event.type !== "message") {
    return null;
  }
  const channelType = event.channel_type === "channel" || event.channel_type === "group"
    ? event.channel_type
    : null;
  if (!channelType || event.subtype !== undefined) {
    return null;
  }
  const channel = readString(event.channel);
  const user = readString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  const threadTs = readString(event.thread_ts);
  const botId = readString(event.bot_id);
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
  if (!isObject(event) || event.type !== "app_mention") {
    return null;
  }
  const channel = readString(event.channel);
  const user = readString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  const ts = readString(event.ts);
  if (!channel || !user || text === null || !ts) {
    return null;
  }
  return {
    type: "app_mention",
    channel,
    user,
    text,
    ts,
    ...(readString(event.thread_ts) ? { thread_ts: readString(event.thread_ts)! } : {}),
    ...(readString(event.bot_id) ? { bot_id: readString(event.bot_id)! } : {}),
  };
};

type ParsedInboundEvent =
  | { kind: "im"; event: SlackMessageImEvent }
  | { kind: "mention"; event: SlackAppMentionEvent }
  | { kind: "channel"; event: SlackChannelMessageEvent }
  | { kind: "app_home_opened"; event: SlackAppHomeOpenedEvent };

const parseInboundEvent = (event: unknown): ParsedInboundEvent | null => {
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

export const createSlackWebhookRouter = (options: SlackWebhookRouterOptions): Router => {
  const router = Router();
  const processingRetryDelaysMs = options.processingRetryDelaysMs ?? DEFAULT_PROCESSING_RETRY_DELAYS_MS;

  router.post("/events", async (req: WebhookRequest, res, next) => {
    try {
      const rawBody = req.rawBody;
      if (!rawBody) {
        res.status(400).json({ error: "Raw body required" });
        return;
      }
      if (!isValidSlackSignature({
        rawBody,
        signatureHeader: req.header("X-Slack-Signature"),
        timestampHeader: req.header("X-Slack-Request-Timestamp"),
        signingSecret: options.signingSecret,
        nowMs: options.now?.(),
      })) {
        options.logger.warn({ event: "slack_inbound", phase: "signature_rejected" }, "Slack signature verification failed");
        res.sendStatus(401);
        return;
      }

      const payload = isObject(req.body) ? req.body : {};
      if (payload.type === "url_verification") {
        res.status(200).json({ challenge: readString(payload.challenge) ?? "" });
        return;
      }

      const eventId = readString(payload.event_id);
      const teamId = readString(payload.team_id);
      if (payload.type !== "event_callback" || !eventId || !teamId) {
        res.sendStatus(200);
        return;
      }

      const inserted = await options.persistence.createInboundEvent({ eventId, teamId });
      if (!inserted) {
        options.logger.info({ teamId, eventId }, "Slack duplicate inbound event skipped");
        res.sendStatus(200);
        return;
      }

      const inbound = parseInboundEvent(payload.event);
      if (!inbound) {
        await options.persistence.markInboundEventStatus(eventId, "skipped");
        res.sendStatus(200);
        return;
      }

      const installation = await options.installations.findByTeamId(teamId);
      if (options.messageHandler.isBotLoop(installation, inbound.event)) {
        await options.persistence.markInboundEventStatus(eventId, "skipped");
        res.sendStatus(200);
        return;
      }

      const dispatch = (): Promise<void> => {
        switch (inbound.kind) {
          case "im":
            return options.messageHandler.handleMessageIm({ eventId, teamId, event: inbound.event });
          case "mention":
            return options.messageHandler.handleAppMention({ eventId, teamId, event: inbound.event });
          case "channel":
            return options.messageHandler.handleChannelMessage({ eventId, teamId, event: inbound.event });
          case "app_home_opened":
            return options.messageHandler.handleAppHomeOpened({ eventId, teamId, event: inbound.event });
        }
      };

      const processInbound = (attempt: number): void => {
        void dispatch().catch((error) => {
          const retryDelayMs = processingRetryDelaysMs[attempt];
          if (retryDelayMs !== undefined) {
            options.logger.warn(
              {
                teamId,
                eventId,
                attempt: attempt + 1,
                retryDelayMs,
                err: error instanceof Error ? error.message : String(error),
              },
              "Slack inbound event processing failed; retry scheduled",
            );
            setTimeout(() => processInbound(attempt + 1), retryDelayMs);
            return;
          }
          options.logger.error(
            { teamId, eventId, attempt: attempt + 1, err: error instanceof Error ? error.message : String(error) },
            "Slack inbound event processing failed",
          );
          void options.persistence.markInboundEventStatus(eventId, "failed").catch((statusError) => {
            options.logger.error(
              {
                teamId,
                eventId,
                err: statusError instanceof Error ? statusError.message : String(statusError),
              },
              "Slack inbound event failure status update failed",
            );
          });
        });
      };

      queueMicrotask(() => processInbound(0));

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
