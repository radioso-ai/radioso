import { describe, expect, it, vi } from "vitest";

import {
  SlackPostActionHandler,
  type SlackPostCredentialResolver,
} from "../../../src/modules/slack/public.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  connectionId: "22222222-2222-2222-2222-222222222222",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  teamId: "T1",
  teamName: "Acme",
  botUserId: "UBOT",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const context = {
  requestId: "request-1",
  workspaceId: installation.workspaceId,
  accountId: null,
  conversationId: "44444444-4444-4444-4444-444444444444",
  idempotencyKey: "slack:gap_escalation:turn-1",
  attempt: 1,
};

describe("SlackPostActionHandler", () => {
  it("resolves installation credentials and posts through the Slack client", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const credentials: SlackPostCredentialResolver = {
      findInstallationById: vi.fn(async () => installation),
      resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
    };
    const handler = new SlackPostActionHandler({
      credentials,
      clientFactory: vi.fn(() => ({ postMessage })),
    });

    await handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Customer question",
        threadTs: "123.456",
        conversationRef: context.conversationId,
        kind: "gap_escalation",
      },
    });

    expect(credentials.findInstallationById).toHaveBeenCalledWith(installation.id);
    expect(credentials.resolveBotTokenForInstallation).toHaveBeenCalledWith(installation);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "CSUPPORT",
      text: "Customer question",
      threadTs: "123.456",
    });
  });

  it("throws on transient Slack failures so the dispatcher records retry/backoff", async () => {
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: () => ({
        postMessage: vi.fn(async () => {
          throw new Error("rate_limited");
        }),
      }),
    });

    await expect(handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Customer question",
        conversationRef: context.conversationId,
        kind: "gap_escalation",
      },
    })).rejects.toThrow("rate_limited");
  });

  it("rejects payloads whose installation belongs to another workspace", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => ({
          ...installation,
          workspaceId: "55555555-5555-4555-8555-555555555555",
        })),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: () => ({ postMessage }),
    });

    await expect(handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Customer question",
        conversationRef: context.conversationId,
        kind: "gap_escalation",
      },
    })).rejects.toThrow("slack_installation_workspace_mismatch");
    expect(postMessage).not.toHaveBeenCalled();
  });
});
