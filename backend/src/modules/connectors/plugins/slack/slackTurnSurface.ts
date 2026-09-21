import type { ConnectorLogger } from "@radioso/connector-api";

import { describeSlackError, type SlackWebApiClient } from "../../../slack/public.js";
import { sessionTitleFromMessage } from "./slackAgentSession.js";

/**
 * Where a turn is happening on Slack. The surface decides how the turn shows its
 * progress: reactions on the originating message in channels and plain DMs, the
 * session status indicator in the agent pane, where a session is a thread in the
 * app DM and is addressed by that thread.
 */
export type SlackTurnSurfaceRef =
  | { kind: "dm" | "channel" }
  | { kind: "dm_session"; threadTs: string };

// "silent": the turn completed but produced nothing to post — a conversation a person has
// taken over answers this way. The surface stops signalling work and claims no outcome.
export type SlackTurnOutcome = "answered" | "silent" | "failed" | "superseded";

interface SlackTurnSurface {
  /** The turn is being worked on. */
  begin(): Promise<void>;
  /** The turn reached a terminal outcome in this attempt. */
  settle(outcome: SlackTurnOutcome): Promise<void>;
  /** The attempt ended without settling; the webhook retry loop owns what happens next. */
  abandon(): Promise<void>;
  /** A conversation was just opened on this surface with the user's first message. */
  nameConversation(firstMessage: string): Promise<void>;
}

type SlackSurfaceClient = Pick<
  SlackWebApiClient,
  "addReaction" | "removeReaction" | "setAgentSessionStatus" | "renameAgentSession"
>;

interface SlackTurnSurfaceInput {
  surface: SlackTurnSurfaceRef;
  client: SlackSurfaceClient;
  logger: ConnectorLogger;
  channel: string;
  /** The originating message. */
  ts: string;
  logContext: { workspaceId: string; installationId: string; eventId: string };
}

// Lifecycle indicator on the originating Slack message: "eyes" while the turn is in
// flight, swapped for a terminal marker once the reply is delivered (or fails).
const SLACK_PROCESSING_REACTION = "eyes";
const SLACK_ANSWERED_REACTION = "white_check_mark";
const SLACK_FAILED_REACTION = "x";

// Progress indicators are best-effort: a failure here must never block or fail the
// actual answer delivery. Logged with ids and the Slack error code only.
const bestEffort = async (
  input: SlackTurnSurfaceInput,
  action: string,
  op: () => Promise<void>,
): Promise<void> => {
  try {
    await op();
  } catch (error) {
    input.logger.warn(
      { ...input.logContext, surface: input.surface.kind, action, ...describeSlackError(error) },
      "Slack turn surface update failed",
    );
  }
};

const reactionSurface = (input: SlackTurnSurfaceInput): SlackTurnSurface => {
  const target = { channel: input.channel, timestamp: input.ts };
  const add = (name: string) => bestEffort(input, `add_${name}`, () => input.client.addReaction({ ...target, name }));
  const remove = (name: string) => bestEffort(input, `remove_${name}`, () => input.client.removeReaction({ ...target, name }));
  return {
    begin: () => add(SLACK_PROCESSING_REACTION),
    async settle(outcome) {
      await remove(SLACK_PROCESSING_REACTION);
      if (outcome === "answered") {
        await add(SLACK_ANSWERED_REACTION);
      } else if (outcome === "failed") {
        await add(SLACK_FAILED_REACTION);
      }
    },
    // The eyes reaction stays until a retry settles the message.
    abandon: async () => undefined,
    nameConversation: async () => undefined,
  };
};

const sessionSurface = (input: SlackTurnSurfaceInput, threadTs: string): SlackTurnSurface => {
  const session = { channelId: input.channel, threadTs };
  // The pane keeps spinning until "active" is set explicitly, so every exit path sets it.
  const setStatus = (status: "processing" | "active") =>
    bestEffort(input, `status_${status}`, () => input.client.setAgentSessionStatus({ ...session, status }));
  return {
    begin: () => setStatus("processing"),
    settle: () => setStatus("active"),
    abandon: () => setStatus("active"),
    nameConversation: (firstMessage) =>
      bestEffort(input, "rename", () =>
        input.client.renameAgentSession({ ...session, title: sessionTitleFromMessage(firstMessage) })),
  };
};

export const createSlackTurnSurface = (input: SlackTurnSurfaceInput): SlackTurnSurface =>
  input.surface.kind === "dm_session" ? sessionSurface(input, input.surface.threadTs) : reactionSurface(input);
