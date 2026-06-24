import { describe, expect, it, vi } from "vitest";

import {
  SlackWebApiClient,
  SlackWebApiError,
  type SlackFetchLike,
} from "../../../src/modules/slack/client/slackWebApiClient.js";

const jsonResponse = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn(async () => payload),
});

describe("SlackWebApiClient", () => {
  it("posts messages with bearer auth and parses successful Slack envelopes", async () => {
    const fetchImpl = vi.fn<SlackFetchLike>().mockResolvedValue(jsonResponse(200, {
      ok: true,
      channel: "C123",
      ts: "1710000000.000001",
      message: { text: "hello" },
    }));
    const client = new SlackWebApiClient({ botToken: "xoxb-token", fetchImpl });

    await expect(client.postMessage({ channel: "C123", text: "hello" })).resolves.toMatchObject({
      channel: "C123",
      ts: "1710000000.000001",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ channel: "C123", text: "hello" }),
      }),
    );
  });

  it("updates messages and includes blocks when provided", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Approved" } }];
    const fetchImpl = vi.fn<SlackFetchLike>().mockResolvedValue(jsonResponse(200, {
      ok: true,
      channel: "C123",
      ts: "1710000000.000001",
    }));
    const client = new SlackWebApiClient({ botToken: "xoxb-token", fetchImpl });

    await expect(client.updateMessage({
      channel: "C123",
      ts: "1710000000.000001",
      text: "Approved",
      blocks,
    })).resolves.toEqual({
      channel: "C123",
      ts: "1710000000.000001",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel: "C123",
          ts: "1710000000.000001",
          text: "Approved",
          blocks,
        }),
      }),
    );
  });

  it("opens Slack views with trigger id and view payload", async () => {
    const fetchImpl = vi.fn<SlackFetchLike>().mockResolvedValue(jsonResponse(200, {
      ok: true,
      view: { id: "V123" },
    }));
    const client = new SlackWebApiClient({ botToken: "xoxb-token", fetchImpl });
    const view = { type: "modal", callback_id: "ownership_reply", title: { type: "plain_text", text: "Reply" } };

    await expect(client.viewsOpen({ triggerId: "trigger-1", view })).resolves.toEqual({ viewId: "V123" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/views.open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ trigger_id: "trigger-1", view }),
      }),
    );
  });

  it("maps Slack ok:false envelopes into typed errors", async () => {
    const fetchImpl = vi.fn<SlackFetchLike>().mockResolvedValue(jsonResponse(200, {
      ok: false,
      error: "channel_not_found",
    }));
    const client = new SlackWebApiClient({ botToken: "xoxb-token", fetchImpl });

    await expect(client.usersInfo("U123")).rejects.toMatchObject({
      name: "SlackWebApiError",
      code: "channel_not_found",
      retryable: false,
    });
  });

  it("marks transient HTTP failures as retryable", async () => {
    const fetchImpl = vi.fn<SlackFetchLike>().mockResolvedValue(jsonResponse(503, {
      ok: false,
      error: "temporarily_unavailable",
    }));
    const client = new SlackWebApiClient({ botToken: "xoxb-token", fetchImpl });

    await expect(client.conversationsList()).rejects.toBeInstanceOf(SlackWebApiError);
    await expect(client.conversationsList()).rejects.toMatchObject({
      retryable: true,
    });
  });
});
