import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  AmqpWebsiteCrawlJobDispatcher,
  parseWebsiteCrawlJobQueueMessage,
} from "../../src/modules/websiteCrawler/jobQueue.js";

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("AMQP website crawl job queue", () => {
  it("preserves the exact durable crawl payload", async () => {
    const channel = Object.assign(new EventEmitter(), {
      assertQueue: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      sendToQueue: vi.fn().mockReturnValue(true),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    });
    const connection = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
      createConfirmChannel: vi.fn().mockResolvedValue(channel),
    });
    const dispatcher = new AmqpWebsiteCrawlJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-website-crawls",
      connect: vi.fn().mockResolvedValue(connection) as never,
      logger: createLogger() as never,
    });

    await dispatcher.dispatch({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      "radioso-website-crawls",
      expect.any(Buffer),
      {
        contentType: "application/json",
        persistent: true,
        type: "website.crawl",
      },
    );
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString("utf8"))).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects extra crawl payload fields", () => {
    expect(() => parseWebsiteCrawlJobQueueMessage({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      changeKinds: ["crawl.status_changed"],
    })).toThrow();
  });
});
