import { describe, expect, it, vi } from "vitest";

import { buildSlackInboundJobComposition } from "../../../src/app/server/builders/integrations.js";
import { SLACK_INBOUND_EVENT_JOB, slackInboundEventJobRequest } from "../../../src/modules/connectors/plugins/slack/slackInboundEventJob.js";
import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  type BackgroundJobWakePort,
} from "../../../src/shared/background-jobs/index.js";
import { InMemoryBackgroundJobStore } from "../../support/inMemoryBackgroundJobStore.js";
import { idleSlackAgentSessionClient } from "../../support/inMemorySlack.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/install/slackInstallationService.js";
import type { SlackInboundEventStatus } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";

describe("Slack inbound job composition (worker)", () => {
  it("builds a background job handler for the slack.inbound_event kind without needing webhook credentials", () => {
    // No SLACK_SIGNING_SECRET or OAuth client id/secret here: this composition is the worker
    // side, which only ever reads a bot token out of the database per installation.
    const composition = buildSlackInboundJobComposition({
      db: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      chatService: { answer: vi.fn(), review: vi.fn() },
      conversationIngestService: { ingest: vi.fn() },
      slackInstallationService: {} as never,
      installations: {} as never,
      bindings: {} as never,
    });

    expect(composition.backgroundJobHandlers).toHaveLength(1);
    expect(composition.backgroundJobHandlers[0]?.kind).toBe(SLACK_INBOUND_EVENT_JOB.kind);
  });

  it("drives a real inbound job from enqueue through the production composition's handler into the chat and Slack clients", async () => {
    // This is the same `buildSlackInboundJobComposition` output `dependencies.ts` spreads into
    // `backgroundJobs.createRuntime([...chat.backgroundJobHandlers, ...slackInboundJobs.backgroundJobHandlers])`.
    // Dropping that spread, or breaking the composition's own wiring, leaves the runtime with no
    // handler for `slack.inbound_event` and this job is never claimed — so the assertions below,
    // which require the fake chat service and Slack client to have actually run, fail.
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
    const answer = vi.fn(async () => ({
      conversationId: "conversation-1",
      answer: "Here is the answer.",
      skillOutcome: undefined,
    }));
    const postMessage = vi.fn(async () => ({ channel: "DUSER", ts: "reply-ts" }));
    const statuses = new Map<string, SlackInboundEventStatus>();
    const persistence = {
      createInboundEvent: vi.fn(async () => true),
      markInboundEventStatus: vi.fn(async (eventId: string, status: "processed" | "skipped" | "failed") => {
        if ((statuses.get(eventId) ?? "received") === "received") {
          statuses.set(eventId, status);
        }
      }),
      getInboundEventStatus: vi.fn(async (eventId: string) => statuses.get(eventId) ?? "received"),
      enqueueInboundEvent: vi.fn(async () => "enqueued" as const),
      findConversationLink: vi.fn(async () => null),
      findConversationLinkByConversationId: vi.fn(async () => null),
      getOrCreateConversationLink: vi.fn(async () => ({
        link: {
          id: "link-1",
          workspaceId: "workspace-1",
          installationId: "installation-1",
          slackKey: "mention:TTEST:DUSER:1718800000.000100",
          conversationId: "conversation-1",
        },
        created: false,
      })),
      upsertConversationLink: vi.fn(),
    };

    const composition = buildSlackInboundJobComposition({
      db: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      chatService: { answer, review: vi.fn() } as never,
      conversationIngestService: { ingest: vi.fn() },
      slackInstallationService: {
        resolveBotTokenForInstallation: async () => "xoxb-test",
        markNeedsReauthForInstallation: async () => false,
      },
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
      persistence,
      clientFactory: () => ({
        postMessage,
        addReaction: vi.fn(async () => undefined),
        removeReaction: vi.fn(async () => undefined),
        ...idleSlackAgentSessionClient(),
      }),
    });

    const store = new InMemoryBackgroundJobStore({ now: () => new Date() });
    const wake: BackgroundJobWakePort = { requestDrain: async () => {} };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger });
    const runtime = new BackgroundJobRuntime({ store, handlers: [...composition.backgroundJobHandlers], wake, logger });

    await queue.enqueue(slackInboundEventJobRequest({
      eventId: "EvAssembly",
      teamId: "TTEST",
      inbound: {
        kind: "im",
        event: {
          type: "message",
          channel_type: "im",
          channel: "DUSER",
          user: "UUSER",
          text: "What are your hours?",
          ts: "1718800000.000100",
        },
      },
    }));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(answer).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(statuses.get("EvAssembly")).toBe("processed");
  });
});
