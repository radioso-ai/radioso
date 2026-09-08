import { describe, expect, it, vi } from "vitest";

import {
  SLACK_MAX_MESSAGE_TEXT_LENGTH,
  SlackPostActionHandler,
  SlackWebApiError,
  type SlackPostCredentialResolver,
} from "../../../src/modules/slack/public.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  connectionId: "22222222-2222-2222-2222-222222222222",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  accountId: "99999999-9999-4999-8999-999999999999",
  teamId: "T1",
  teamName: "Acme",
  botUserId: "UBOT",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const context = {
  requestId: "request-1",
  workspaceId: installation.workspaceId,
  accountId: installation.accountId,
  conversationId: "44444444-4444-4444-4444-444444444444",
  idempotencyKey: "slack:gap_escalation:turn-1",
  attempt: 1,
  skillName: null,
};

describe("SlackPostActionHandler", () => {
  it("resolves installation credentials and posts through the Slack client", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const credentials: SlackPostCredentialResolver = {
      findInstallationById: vi.fn(async () => installation),
      markNeedsReauthForInstallation: vi.fn(async () => true),
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

  it("posts interactive block messages with fallback text", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation: vi.fn(async () => true),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: vi.fn(() => ({ postMessage })),
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Approval needed" } }];

    await handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Approval needed",
        blocks,
        conversationRef: context.conversationId,
        kind: "operator_notification",
      },
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "CSUPPORT",
      text: "Approval needed",
      blocks,
    });
  });

  it("updates an existing Slack message when updateTs is present", async () => {
    const postMessage = vi.fn();
    const updateMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "9.9" }));
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation: vi.fn(async () => true),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: vi.fn(() => ({ postMessage, updateMessage })),
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Approved" } }];

    await handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Approved",
        blocks,
        updateTs: "9.9",
        conversationRef: context.conversationId,
        kind: "operator_notification",
      },
    });

    expect(updateMessage).toHaveBeenCalledWith({
      channel: "CSUPPORT",
      ts: "9.9",
      text: "Approved",
      blocks,
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("throws on transient Slack failures so the dispatcher records retry/backoff", async () => {
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation: vi.fn(async () => true),
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

  it("allows payloads whose installation is homed in a sibling workspace in the same account", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const siblingContext = {
      ...context,
      workspaceId: "55555555-5555-4555-8555-555555555555",
      accountId: installation.accountId,
    };
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation: vi.fn(async () => true),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: () => ({ postMessage }),
    });

    await handler.handle({
      context: siblingContext,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text: "Customer question",
        conversationRef: context.conversationId,
        kind: "gap_escalation",
      },
    });

    expect(postMessage).toHaveBeenCalled();
  });

  it("rejects payloads whose installation belongs to another account", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => ({
          ...installation,
          accountId: "55555555-5555-4555-8555-555555555555",
        })),
        markNeedsReauthForInstallation: vi.fn(async () => true),
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
    })).rejects.toThrow("slack_installation_account_mismatch");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("marks the Slack connection needs_reauth when the bot token is missing", async () => {
    const markNeedsReauthForInstallation = vi.fn(async () => true);
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation,
        resolveBotTokenForInstallation: vi.fn(async () => null),
      },
      clientFactory: () => ({ postMessage: vi.fn() }),
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
    })).rejects.toThrow("slack_bot_token_not_found");
    expect(markNeedsReauthForInstallation).toHaveBeenCalledWith(installation, "slack_bot_token_not_found");
  });

  it("marks the Slack connection needs_reauth when Slack rejects the token", async () => {
    const markNeedsReauthForInstallation = vi.fn(async () => true);
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation,
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: () => ({
        postMessage: vi.fn(async () => {
          throw new SlackWebApiError("token_revoked", "Slack token was revoked");
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
    })).rejects.toThrow("Slack token was revoked");
    expect(markNeedsReauthForInstallation).toHaveBeenCalledWith(installation, "token_revoked");
  });

  it("splits long Slack posts into bounded messages", async () => {
    const postMessage = vi.fn(async () => ({ channel: "CSUPPORT", ts: "1.2" }));
    const handler = new SlackPostActionHandler({
      credentials: {
        findInstallationById: vi.fn(async () => installation),
        markNeedsReauthForInstallation: vi.fn(async () => true),
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      clientFactory: () => ({ postMessage }),
    });
    const text = `${"a".repeat(SLACK_MAX_MESSAGE_TEXT_LENGTH)}tail`;

    await handler.handle({
      context,
      payload: {
        installationId: installation.id,
        channelId: "CSUPPORT",
        text,
        conversationRef: context.conversationId,
        kind: "gap_escalation",
      },
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    const calls = postMessage.mock.calls as unknown as Array<[{ text: string }]>;
    expect(calls[0][0].text).toHaveLength(SLACK_MAX_MESSAGE_TEXT_LENGTH);
    expect(calls[1][0].text).toBe("tail");
  });
});
