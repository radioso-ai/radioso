import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AmqpDocumentJobConsumer,
  AmqpDocumentJobDispatcher,
  type AmqpConnect,
} from "../../src/modules/documents/infra/amqpDocumentJobQueue.js";
import { parseDocumentJobQueueMessage } from "../../src/modules/documents/services/documentJobMessage.js";

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createAmqpHarness = () => {
  const channel = Object.assign(new EventEmitter(), {
    ack: vi.fn(),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: "consumer-1" }),
    nack: vi.fn(),
    prefetch: vi.fn().mockResolvedValue(undefined),
    sendToQueue: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
  });
  const connection = Object.assign(new EventEmitter(), {
    close: vi.fn().mockResolvedValue(undefined),
    createChannel: vi.fn().mockResolvedValue(channel),
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
  });
  const connect = vi.fn().mockResolvedValue(connection);

  return { channel, connect: connect as AmqpConnect, connection };
};

describe("AMQP document job queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes persistent document job messages to a durable queue", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    const dispatcher = new AmqpDocumentJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
    });

    await dispatcher.dispatch({
      jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      revision: 2,
    });

    expect(connect).toHaveBeenCalledWith("amqp://localhost:5672");
    expect(connection.createConfirmChannel).toHaveBeenCalled();
    expect(channel.assertQueue).toHaveBeenCalledWith("radioso-document-jobs", { durable: true });
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      "radioso-document-jobs",
      expect.any(Buffer),
      expect.objectContaining({
        contentType: "application/json",
        persistent: true,
        type: "document.processing",
      }),
    );
    expect(channel.waitForConfirms).toHaveBeenCalledOnce();
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString("utf8"))).toEqual({
      jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      revision: 2,
    });
  });

  it("keeps enrichment options out of the queue message contract", () => {
    expect(() =>
      parseDocumentJobQueueMessage({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
        options: { documentEnrichmentOverride: "on" },
      }),
    ).toThrow();
  });

  it("asserts the dead-letter queue and wires it onto the main queue when configured", async () => {
    const { channel, connect } = createAmqpHarness();
    const dispatcher = new AmqpDocumentJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      deadLetterQueueName: "radioso-document-jobs.dlq",
      connect,
      logger: createLogger() as any,
    });

    await dispatcher.dispatch({
      jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      revision: 2,
    });

    expect(channel.assertQueue).toHaveBeenCalledWith("radioso-document-jobs.dlq", { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith("radioso-document-jobs", {
      durable: true,
      deadLetterExchange: "",
      deadLetterRoutingKey: "radioso-document-jobs.dlq",
    });
  });

  it("publishes dispatch batches sequentially", async () => {
    const { channel, connect } = createAmqpHarness();
    const dispatcher = new AmqpDocumentJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
    });

    await dispatcher.dispatchMany([
      {
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
        documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
        workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
        revision: 2,
      },
      {
        jobId: "44cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
        documentId: "88d89bb2-b69a-43b0-b226-62f40d160321",
        workspaceId: "f93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
        revision: 3,
      },
    ]);

    expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
  });

  it("closes the publisher connection when confirm channel creation fails", async () => {
    const { connect, connection } = createAmqpHarness();
    connection.createConfirmChannel.mockRejectedValueOnce(new Error("confirm unavailable"));
    const dispatcher = new AmqpDocumentJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
    });

    await expect(dispatcher.dispatch({
      jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      revision: 2,
    })).rejects.toThrow("confirm unavailable");

    expect(connection.close).toHaveBeenCalled();
  });

  it("logs publisher lifecycle errors without unhandled EventEmitter crashes", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    const logger = createLogger();
    const dispatcher = new AmqpDocumentJobDispatcher({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
    });

    await dispatcher.dispatch({
      jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      revision: 2,
    });

    connection.emit("error", new Error("connection interrupted"));
    channel.emit("error", new Error("channel interrupted"));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-dispatcher",
        resource: "connection",
      }),
      "AMQP document job dispatcher lifecycle error",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-dispatcher",
        resource: "channel",
      }),
      "AMQP document job dispatcher lifecycle error",
    );
  });

  it("consumes valid messages through the worker job-by-id path and acknowledges success", async () => {
    const { channel, connect } = createAmqpHarness();
    const worker = {
      runJobById: vi.fn().mockResolvedValue("processed"),
    };
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      busyRequeueDelayMs: 0,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    const message = {
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    };
    await onMessage(message);

    expect(channel.prefetch).toHaveBeenCalledWith(1);
    expect(worker.runJobById).toHaveBeenCalledWith("33cc6be4-1a3a-4b43-9714-e87e9f9a60ab");
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("rejects malformed messages without requeue so poison payloads route to DLQ or are dropped", async () => {
    const { channel, connect } = createAmqpHarness();
    const worker = {
      runJobById: vi.fn(),
    };
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      deadLetterQueueName: "radioso-document-jobs.dlq",
      connect,
      logger: logger as any,
      busyRequeueDelayMs: 0,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    const message = {
      content: Buffer.from("{not-json"),
    };
    await onMessage(message);

    expect(worker.runJobById).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        deadLetterQueueName: "radioso-document-jobs.dlq",
        rawPayloadBase64: expect.any(String),
      }),
      "Rejected invalid document job queue message",
    );
  });

  it("requeues messages when the durable job is busy", async () => {
    const { channel, connect } = createAmqpHarness();
    const worker = {
      runJobById: vi.fn().mockResolvedValue("busy"),
    };
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      busyRequeueDelayMs: 0,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    const message = {
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    };
    await onMessage(message);

    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("requeues messages when job processing throws", async () => {
    vi.useFakeTimers();
    const { channel, connect } = createAmqpHarness();
    const worker = {
      runJobById: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
      busyRequeueDelayMs: 10,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    const message = {
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    };
    const handling = onMessage(message);
    await Promise.resolve();

    expect(channel.nack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    await handling;
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      }),
      "Document job queue message handling failed",
    );
  });

  it("logs lifecycle errors and reconnects after unexpected broker closes", async () => {
    vi.useFakeTimers();
    const first = createAmqpHarness();
    const second = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection);
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
      reconnectDelayMs: 10,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    first.channel.emit("error", new Error("channel down"));
    first.connection.emit("close");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        resource: "channel",
      }),
      "AMQP document job consumer lifecycle error",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        resource: "connection",
      }),
      "AMQP document job consumer closed unexpectedly",
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledOnce();

    await consumer.stop();
  });

  it("closes the old connection before reconnecting after a channel-only close", async () => {
    vi.useFakeTimers();
    const first = createAmqpHarness();
    const second = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection);
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      reconnectDelayMs: 10,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    first.channel.emit("close");
    await vi.advanceTimersByTimeAsync(10);

    expect(first.connection.close).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledOnce();

    await consumer.stop();
  });

  it("ignores stale close events from an old channel after reconnect succeeds", async () => {
    vi.useFakeTimers();
    const first = createAmqpHarness();
    const second = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection);
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      reconnectDelayMs: 10,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    first.connection.emit("close");
    await vi.advanceTimersByTimeAsync(10);
    first.channel.emit("close");
    await vi.advanceTimersByTimeAsync(10);
    await consumer.stop();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(second.channel.close).toHaveBeenCalled();
    expect(second.connection.close).toHaveBeenCalled();
  });

  it("keeps polling fallback active and schedules reconnect when initial broker startup fails", async () => {
    vi.useFakeTimers();
    const failed = createAmqpHarness();
    failed.channel.assertQueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const recovered = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(failed.connection)
      .mockResolvedValueOnce(recovered.connection);
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
      reconnectDelayMs: 10,
      worker: { runJobById: vi.fn() },
    });

    await expect(consumer.start()).resolves.toBeUndefined();

    expect(failed.channel.close).toHaveBeenCalled();
    expect(failed.connection.close).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        error: "queue unavailable",
      }),
      "AMQP document job consumer startup failed; database polling remains active",
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(recovered.channel.consume).toHaveBeenCalledOnce();

    await consumer.stop();
  });

  it("backs off repeated AMQP reconnect failures up to the configured cap", async () => {
    vi.useFakeTimers();
    const first = createAmqpHarness();
    first.channel.assertQueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const second = createAmqpHarness();
    second.channel.assertQueue.mockRejectedValueOnce(new Error("queue still unavailable"));
    const recovered = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection)
      .mockResolvedValueOnce(recovered.connection);
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 20,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(connect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(19);
    expect(connect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(recovered.channel.consume).toHaveBeenCalledOnce();

    await consumer.stop();
  });

  it("closes broker resources on stop", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    await consumer.stop();

    expect(channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it("continues shutdown cleanup when cancel fails", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    channel.cancel.mockRejectedValueOnce(new Error("already closed"));
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    await expect(consumer.stop()).resolves.toBeUndefined();

    expect(channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerTag: "consumer-1",
      }),
      "Failed to cancel AMQP consumer",
    );
  });

  it("waits for in-flight message handling before closing broker resources", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    let resolveJob: (value: "processed") => void = () => {};
    const worker = {
      runJobById: vi.fn().mockReturnValue(new Promise<"processed">((resolve) => {
        resolveJob = resolve;
      })),
    };
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    onMessage({
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    });
    const stopping = consumer.stop();
    await Promise.resolve();

    expect(channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(channel.close).not.toHaveBeenCalled();

    resolveJob("processed");
    await stopping;

    expect(channel.ack).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it("does not leave a live consumer when shutdown races with reconnect", async () => {
    vi.useFakeTimers();
    const first = createAmqpHarness();
    let resolveReconnect: (value: typeof first.connection) => void = () => {};
    const secondConnectionPromise = new Promise<typeof first.connection>((resolve) => {
      resolveReconnect = resolve;
    });
    const second = createAmqpHarness();
    const connect = vi.fn()
      .mockResolvedValueOnce(first.connection)
      .mockReturnValueOnce(secondConnectionPromise);
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      reconnectDelayMs: 10,
      worker: { runJobById: vi.fn() },
    });

    await consumer.start();
    first.connection.emit("close");
    await vi.advanceTimersByTimeAsync(10);
    const stopping = consumer.stop();
    await Promise.resolve();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).not.toHaveBeenCalled();

    resolveReconnect(second.connection);
    await stopping;

    expect(second.channel.consume).toHaveBeenCalledOnce();
    expect(second.channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(second.channel.close).toHaveBeenCalled();
    expect(second.connection.close).toHaveBeenCalled();
  });

  it("waits for in-flight message handling after an unexpected broker close before shutdown completes", async () => {
    const { channel, connect, connection } = createAmqpHarness();
    let resolveJob: (value: "processed") => void = () => {};
    const worker = {
      runJobById: vi.fn().mockReturnValue(new Promise<"processed">((resolve) => {
        resolveJob = resolve;
      })),
    };
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: createLogger() as any,
      worker,
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];
    const handling = onMessage({
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    });
    connection.emit("close");
    const stopping = consumer.stop();
    await Promise.resolve();

    expect(channel.close).not.toHaveBeenCalled();

    resolveJob("processed");
    await handling;
    await stopping;

    expect(channel.ack).toHaveBeenCalled();
    expect(channel.close).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
  });

  it("logs settlement failures without rejecting the in-flight handler", async () => {
    const { channel, connect } = createAmqpHarness();
    channel.ack.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });
    const logger = createLogger();
    const consumer = new AmqpDocumentJobConsumer({
      amqpUrl: "amqp://localhost:5672",
      queueName: "radioso-document-jobs",
      connect,
      logger: logger as any,
      worker: {
        runJobById: vi.fn().mockResolvedValue("processed"),
      },
    });

    await consumer.start();
    const onMessage = channel.consume.mock.calls[0][1];

    await expect(onMessage({
      content: Buffer.from(JSON.stringify({
        jobId: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      })),
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "amqp-document-job-consumer",
        error: "channel closed",
      }),
      "Failed to acknowledge AMQP document job message",
    );
  });
});
