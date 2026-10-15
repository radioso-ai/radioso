import { describe, expect, it, vi } from "vitest";

import { buildSlackInboundJobComposition } from "../../../src/app/server/builders/integrations.js";
import { SLACK_INBOUND_EVENT_JOB } from "../../../src/modules/connectors/plugins/slack/slackInboundEventJob.js";

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
});
