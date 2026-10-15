import { describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  type BackgroundJobWakePort,
} from "../../../src/shared/background-jobs/index.js";
import { InMemoryBackgroundJobStore } from "../../support/inMemoryBackgroundJobStore.js";
import {
  SLACK_INBOUND_EVENT_JOB,
  createSlackInboundEventJobHandler,
  slackInboundEventJobRequest,
  type SlackInboundEventJobPayload,
} from "../../../src/modules/connectors/plugins/slack/slackInboundEventJob.js";
import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import { ChatTurnSupersededError } from "../../../src/modules/chat/services/conversationTurnRegistry.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/install/slackInstallationService.js";
import { idleSlackAgentSessionClient } from "../../support/inMemorySlack.js";

const START = new Date("2026-10-15T10:00:00.000Z");

const createClock = () => {
  let current = START.getTime();
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current += seconds * 1_000;
    },
  };
};

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const installation: SlackInstallationRecord = {
  id: "installation-1",
  connectionId: "connection-1",
  workspaceId: "workspace-1",
  accountId: "account-1",
  teamId: "TTEST",
  teamName: "Test Slack",
  botUserId: "UBOT",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const imPayload = (): SlackInboundEventJobPayload => ({
  eventId: "EvAsync",
  teamId: "TTEST",
  inbound: {
    kind: "im" as const,
    event: {
      type: "message" as const,
      channel_type: "im" as const,
      channel: "DUSER",
      user: "UUSER",
      text: "Question",
      ts: "1718800000.000100",
    },
  },
});

const setup = (
  messageHandler: Parameters<typeof createSlackInboundEventJobHandler>[0],
  persistence: Parameters<typeof createSlackInboundEventJobHandler>[1],
) => {
  const clock = createClock();
  const store = new InMemoryBackgroundJobStore(clock);
  const wake: BackgroundJobWakePort & { requestDrain: ReturnType<typeof vi.fn> } = {
    requestDrain: vi.fn(async () => {}),
  };
  const logger = createLogger();
  const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger });
  const runtime = new BackgroundJobRuntime({
    store,
    handlers: [createSlackInboundEventJobHandler(messageHandler, persistence, logger)],
    wake,
    logger,
    now: clock.now,
  });
  return { clock, store, queue, runtime, logger };
};

describe("Slack inbound event job handler", () => {
  it("pins its deadline to the port maximum, with a lease above it and below the worker's request timeout", () => {
    // No AbortSignal reaches the chat turn, so the timeout cannot stop a running handler early —
    // a tighter deadline would let the original attempt and a retry both post a reply. Pinning the
    // deadline to the port's ceiling makes a retry fire only once a worker genuinely stops
    // renewing the lease, not because a slow-but-live turn outran an arbitrary budget.
    expect(SLACK_INBOUND_EVENT_JOB.policy.timeoutSeconds).toBe(BACKGROUND_JOB_MAX_TIMEOUT_SECONDS);
    expect(SLACK_INBOUND_EVENT_JOB.policy.leaseSeconds).toBeGreaterThan(SLACK_INBOUND_EVENT_JOB.policy.timeoutSeconds);
    // The document worker's own Cloud Run request deadline (infra/terraform/compute.tf).
    expect(SLACK_INBOUND_EVENT_JOB.policy.leaseSeconds).toBeLessThan(300);
  });

  it("dispatches each inbound kind to its matching message-handler method and completes the job", async () => {
    const handleMessageIm = vi.fn(async () => undefined);
    const persistence = { markInboundEventStatus: vi.fn(async () => undefined) };
    const { queue, runtime, store } = setup(
      { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    const payload = imPayload();
    await queue.enqueue(slackInboundEventJobRequest(payload));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(handleMessageIm).toHaveBeenCalledWith({
      eventId: payload.eventId,
      teamId: payload.teamId,
      event: payload.inbound.event,
    });
    expect(store.rows.size).toBe(0);
    expect(persistence.markInboundEventStatus).not.toHaveBeenCalled();
  });

  it("retries a failing turn through the port and marks the inbound event failed only on the final attempt", async () => {
    const handleMessageIm = vi.fn(async () => {
      throw new Error("chat_unavailable");
    });
    const persistence = { markInboundEventStatus: vi.fn(async () => undefined) };
    const { clock, queue, runtime } = setup(
      { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    await queue.enqueue(slackInboundEventJobRequest(imPayload()));

    for (let attempt = 1; attempt < SLACK_INBOUND_EVENT_JOB.policy.maxAttempts; attempt += 1) {
      const result = await runtime.drain({ maxJobs: 1 });
      expect(result).toMatchObject({ claimed: 1, retried: 1 });
      expect(persistence.markInboundEventStatus).not.toHaveBeenCalled();
      clock.advanceSeconds(3_600);
    }

    const final = await runtime.drain({ maxJobs: 1 });
    expect(final).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(handleMessageIm).toHaveBeenCalledTimes(SLACK_INBOUND_EVENT_JOB.policy.maxAttempts);
    expect(persistence.markInboundEventStatus).toHaveBeenCalledOnce();
    expect(persistence.markInboundEventStatus).toHaveBeenCalledWith("EvAsync", "failed");
  });

  it("never marks the inbound event failed once a retry succeeds", async () => {
    let attempts = 0;
    const handleMessageIm = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary_chat_unavailable");
      }
    });
    const persistence = { markInboundEventStatus: vi.fn(async () => undefined) };
    const { clock, queue, runtime } = setup(
      { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    await queue.enqueue(slackInboundEventJobRequest(imPayload()));

    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, retried: 1 });
    clock.advanceSeconds(3_600);
    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, completed: 1 });
    expect(handleMessageIm).toHaveBeenCalledTimes(2);
    expect(persistence.markInboundEventStatus).not.toHaveBeenCalled();
  });

  it("coalesces a redelivery of the same Slack event id into one waiting job", async () => {
    const persistence = { markInboundEventStatus: vi.fn(async () => undefined) };
    const { queue, store } = setup(
      { handleMessageIm: vi.fn(), handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    const payload = imPayload();

    await queue.enqueue(slackInboundEventJobRequest(payload));
    await queue.enqueue(slackInboundEventJobRequest(payload));

    expect(store.rows.size).toBe(1);
  });

  it("completes without retrying a superseded turn, and leaves the inbound event skipped", async () => {
    const answer = vi.fn(async () => {
      throw new ChatTurnSupersededError("conversation-1", "routing");
    });
    const markInboundEventStatus = vi.fn(async () => undefined);
    const handler = new SlackMessageHandler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      chat: { answer },
      installations: { findByTeamId: async () => installation } as never,
      bindings: {
        findAnswerer: async () => ({
          id: "binding-1",
          connectionId: "connection-1",
          workspaceId: "workspace-1",
          channelId: null,
          answeringAgentId: "agent-1",
          escalationChannelId: null,
          gapEscalationEnabled: false,
        }),
      } as never,
      installationService: {
        resolveBotTokenForInstallation: async () => "xoxb-test",
        markNeedsReauthForInstallation: async () => false,
      },
      persistence: {
        getOrCreateConversationLink: async () => ({
          link: {
            id: "link-1",
            workspaceId: "workspace-1",
            installationId: "installation-1",
            slackKey: "mention:TTEST:C1:1.0",
            conversationId: "conversation-1",
          },
          created: false,
        }),
        markInboundEventStatus,
      } as never,
      clientFactory: () => ({
        postMessage: vi.fn(async () => ({ channel: "DUSER", ts: "reply-ts" })),
        addReaction: vi.fn(async () => undefined),
        removeReaction: vi.fn(async () => undefined),
        ...idleSlackAgentSessionClient(),
      }),
    });
    const { queue, runtime } = setup(handler, { markInboundEventStatus: vi.fn(async () => undefined) });
    await queue.enqueue(slackInboundEventJobRequest(imPayload()));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(markInboundEventStatus).toHaveBeenCalledWith("EvAsync", "skipped");
  });
});
