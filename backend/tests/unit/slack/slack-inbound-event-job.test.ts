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
import type { SlackInboundEventStatus } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
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

const imPayload = (eventId = "EvAsync"): SlackInboundEventJobPayload => ({
  eventId,
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

/**
 * Mirrors `PostgresSlackPersistence`'s guard on a Map: a write only lands while the event is still
 * `received`, so a late write from an attempt the port already abandoned (lease reclaimed, a
 * later attempt already settled the event) is a no-op, never an overwrite.
 */
const createFakePersistence = (initial: Partial<Record<string, SlackInboundEventStatus>> = {}) => {
  const statuses = new Map<string, SlackInboundEventStatus>(
    Object.entries(initial).filter((entry): entry is [string, SlackInboundEventStatus] => entry[1] !== undefined),
  );
  return {
    statuses,
    markInboundEventStatus: vi.fn(async (eventId: string, status: "processed" | "skipped" | "failed") => {
      if ((statuses.get(eventId) ?? "received") === "received") {
        statuses.set(eventId, status);
      }
    }),
    getInboundEventStatus: vi.fn(async (eventId: string) => statuses.get(eventId) ?? "received"),
  };
};

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
    const persistence = createFakePersistence();
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

  it.each(["processed", "skipped", "failed"] as const)(
    "returns success without dispatching when the inbound event is already terminal (%s)",
    async (terminalStatus) => {
      const handleMessageIm = vi.fn(async () => undefined);
      // A redelivery the webhook's own dedupe somehow let through, or a retry racing an attempt
      // whose own write already landed — including a dead-lettered `failed`, so a retry that
      // somehow still runs after the job was parked does not re-dispatch the turn.
      const persistence = createFakePersistence({ EvAsync: terminalStatus });
      const { queue, runtime } = setup(
        { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
        persistence,
      );
      await queue.enqueue(slackInboundEventJobRequest(imPayload()));

      const result = await runtime.drain({ maxJobs: 1 });

      expect(result).toMatchObject({ claimed: 1, completed: 1 });
      expect(handleMessageIm).not.toHaveBeenCalled();
    },
  );

  it("marks the inbound event failed via the dead-letter hook only on the final attempt", async () => {
    const handleMessageIm = vi.fn(async () => {
      throw new Error("chat_unavailable");
    });
    const persistence = createFakePersistence();
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
    // The third argument is the dead-letter hook's parking transaction (an opaque stand-in here).
    expect(persistence.markInboundEventStatus).toHaveBeenCalledWith("EvAsync", "failed", expect.anything());
    expect(persistence.statuses.get("EvAsync")).toBe("failed");
  });

  it("logs the Slack event id when the dead-letter status write itself fails, leaving the event received", async () => {
    const handleMessageIm = vi.fn(async () => {
      throw new Error("chat_unavailable");
    });
    const markInboundEventStatus = vi.fn(async () => {
      throw new Error("db_unavailable");
    });
    const persistence = { markInboundEventStatus, getInboundEventStatus: vi.fn(async () => "received" as const) };
    const { clock, queue, runtime, logger } = setup(
      { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    await queue.enqueue(slackInboundEventJobRequest(imPayload()));

    for (let attempt = 1; attempt < SLACK_INBOUND_EVENT_JOB.policy.maxAttempts; attempt += 1) {
      await runtime.drain({ maxJobs: 1 });
      clock.advanceSeconds(3_600);
    }
    // The port still parks the job on its own terms — without the hook's write — once the hook
    // itself fails; it never retries the hook. The event's own row is left `received`: nothing
    // will ever claim this job again to try marking it `failed`.
    const final = await runtime.drain({ maxJobs: 1 });

    expect(final).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(markInboundEventStatus).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "EvAsync",
        teamId: "TTEST",
        kind: SLACK_INBOUND_EVENT_JOB.kind,
        errorType: "Error",
      }),
      "Slack inbound event dead-letter status write failed; the event stays received",
    );
  });

  it("marks the inbound event failed, by idempotency key, when the stored payload no longer parses", async () => {
    const handleMessageIm = vi.fn();
    const persistence = createFakePersistence();
    const { runtime, store } = setup(
      { handleMessageIm, handleAppMention: vi.fn(), handleChannelMessage: vi.fn(), handleAppHomeOpened: vi.fn() },
      persistence,
    );
    // A payload that cannot have come from `slackInboundEventJobRequest`: the schema change that
    // broke it, or corruption, not something the catch-based approach this replaces could ever see
    // (the old code never ran — and never got a chance to write `failed` — because the generic
    // runtime rejects an unparseable payload before calling any handler).
    await store.insert({
      kind: SLACK_INBOUND_EVENT_JOB.kind,
      payload: { not: "a valid slack inbound event payload" },
      onDuplicateKey: "ignore",
      idempotencyKey: "EvBadPayload",
    });

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(handleMessageIm).not.toHaveBeenCalled();
    expect(persistence.markInboundEventStatus).toHaveBeenCalledWith("EvBadPayload", "failed", expect.anything());
  });

  it("never marks the inbound event failed once a retry succeeds", async () => {
    let attempts = 0;
    const handleMessageIm = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary_chat_unavailable");
      }
    });
    const persistence = createFakePersistence();
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
    const persistence = createFakePersistence();
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
    const { queue, runtime } = setup(handler, createFakePersistence());
    await queue.enqueue(slackInboundEventJobRequest(imPayload()));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(markInboundEventStatus).toHaveBeenCalledWith("EvAsync", "skipped");
  });
});
