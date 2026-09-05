import * as amqp from "amqplib";
import { ZodError } from "zod";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { DocumentJobConsumerPort } from "../services/documentJobConsumer.js";
import type { DocumentJobDispatchRequest, DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";
import {
  parseDocumentJobQueueMessage,
  toDocumentJobQueueMessage,
} from "../services/documentJobMessage.js";

export type AmqpConnect = (url: string) => Promise<amqp.ChannelModel>;
const DEFAULT_BUSY_REQUEUE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 2;

interface AmqpDocumentJobQueueOptions {
  amqpUrl: string;
  queueName: string;
  deadLetterQueueName?: string;
  connect?: AmqpConnect;
  logger: AppLogger;
}

const buildMainQueueOptions = (deadLetterQueueName?: string): amqp.Options.AssertQueue => {
  const options: amqp.Options.AssertQueue = { durable: true };
  if (deadLetterQueueName) {
    options.deadLetterExchange = "";
    options.deadLetterRoutingKey = deadLetterQueueName;
  }
  return options;
};

const assertQueuesWithDlq = async (
  channel: amqp.Channel | amqp.ConfirmChannel,
  queueName: string,
  deadLetterQueueName: string | undefined,
): Promise<void> => {
  if (deadLetterQueueName) {
    await channel.assertQueue(deadLetterQueueName, { durable: true });
  }
  await channel.assertQueue(queueName, buildMainQueueOptions(deadLetterQueueName));
};

export type AmqpDocumentJobDispatcherOptions = AmqpDocumentJobQueueOptions;

export class AmqpDocumentJobDispatcher implements DocumentJobDispatcherPort {
  private readonly connect: AmqpConnect;

  constructor(private readonly options: AmqpDocumentJobDispatcherOptions) {
    this.connect = options.connect ?? amqp.connect;
  }

  async dispatch(input: DocumentJobDispatchRequest): Promise<void> {
    let connection: amqp.ChannelModel | null = null;
    let channel: amqp.ConfirmChannel | null = null;

    try {
      connection = await this.connect(this.options.amqpUrl);
      connection.on("error", (error) => {
        this.logPublishLifecycleError("connection", error);
      });
      channel = await connection.createConfirmChannel();
      channel.on("error", (error) => {
        this.logPublishLifecycleError("channel", error);
      });
      await assertQueuesWithDlq(channel, this.options.queueName, this.options.deadLetterQueueName);
      const payload = toDocumentJobQueueMessage(input);
      channel.sendToQueue(
        this.options.queueName,
        Buffer.from(JSON.stringify(payload), "utf8"),
        {
          contentType: "application/json",
          persistent: true,
          type: "document.processing",
        },
      );
      await channel.waitForConfirms();

      this.options.logger.info(
        {
          role: "amqp-document-job-dispatcher",
          jobId: input.jobId,
          documentId: input.documentId,
          workspaceId: input.workspaceId,
          revision: input.revision,
          queueName: this.options.queueName,
          databaseScheduled: Boolean(input.scheduleAt),
        },
        "Dispatched document processing job to AMQP queue",
      );
    } finally {
      if (channel) {
        await closeQuietly(channel, this.options.logger, "amqp-document-job-dispatcher channel");
      }
      if (connection) {
        await closeQuietly(connection, this.options.logger, "amqp-document-job-dispatcher connection");
      }
    }
  }

  async dispatchMany(inputs: DocumentJobDispatchRequest[]): Promise<void> {
    for (const input of inputs) {
      await this.dispatch(input);
    }
  }

  private logPublishLifecycleError(resource: "connection" | "channel", error: unknown): void {
    this.options.logger.error(
      {
        role: "amqp-document-job-dispatcher",
        queueName: this.options.queueName,
        resource,
        error: error instanceof Error ? error.message : String(error),
      },
      "AMQP document job dispatcher lifecycle error",
    );
  }
}

export interface AmqpDocumentJobConsumerOptions extends AmqpDocumentJobQueueOptions {
  prefetch?: number;
  busyRequeueDelayMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  worker: {
    runJobById(jobId: string): Promise<"processed" | "noop" | "busy">;
  };
}

export class AmqpDocumentJobConsumer implements DocumentJobConsumerPort {
  private readonly connect: AmqpConnect;
  private channel: amqp.Channel | null = null;
  private connection: amqp.ChannelModel | null = null;
  private consumerTag: string | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private running = false;
  private stopping = false;

  constructor(private readonly options: AmqpDocumentJobConsumerOptions) {
    this.connect = options.connect ?? amqp.connect;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;
    try {
      await this.openConsumer();
    } catch (error) {
      this.options.logger.error(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
          error: error instanceof Error ? error.message : String(error),
        },
        "AMQP document job consumer startup failed; database polling remains active",
      );
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.reconnectPromise;
    const channel = this.channel;
    const connection = this.connection;
    const consumerTag = this.consumerTag;

    if (channel) {
      if (consumerTag) {
        await cancelQuietly(channel, consumerTag, this.options.logger);
      }
    }
    await Promise.allSettled([...this.inFlight]);
    if (channel) {
      await closeQuietly(channel, this.options.logger, "amqp-document-job-consumer channel");
    }
    if (connection) {
      await closeQuietly(connection, this.options.logger, "amqp-document-job-consumer connection");
    }
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
    this.stopping = false;
  }

  private async openConsumer(): Promise<void> {
    let connection: amqp.ChannelModel | null = null;
    let channel: amqp.Channel | null = null;
    try {
      connection = await this.connect(this.options.amqpUrl);
      channel = await connection.createChannel();
      this.bindLifecycleHandlers(connection, channel);
      await assertQueuesWithDlq(channel, this.options.queueName, this.options.deadLetterQueueName);
      await channel.prefetch(this.options.prefetch ?? 1);
      // amqplib's consume callback type is void-returning, but returning the in-flight promise
      // below is intentional: it lets tests (and any future caller) await message handling
      // directly instead of only observing it via the internal `inFlight` set.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- see comment above
      const consumer = await channel.consume(this.options.queueName, (message) => {
        const processing: Promise<void> = this.handleMessage(channel!, message)
          .catch((error) => {
            this.options.logger.error(
              {
                role: "amqp-document-job-consumer",
                queueName: this.options.queueName,
                error: error instanceof Error ? error.message : String(error),
              },
              "Unhandled document job queue message failure",
            );
          })
          .finally(() => {
            this.inFlight.delete(processing);
          });
        this.inFlight.add(processing);
        return processing;
      });
      this.connection = connection;
      this.channel = channel;
      this.consumerTag = consumer.consumerTag;
    } catch (error) {
      if (channel) {
        await closeQuietly(channel, this.options.logger, "amqp-document-job-consumer channel");
      }
      if (connection) {
        await closeQuietly(connection, this.options.logger, "amqp-document-job-consumer connection");
      }
      throw error;
    }

    this.options.logger.info(
      {
        role: "amqp-document-job-consumer",
        queueName: this.options.queueName,
        prefetch: this.options.prefetch ?? 1,
      },
      "AMQP document job consumer started",
    );
  }

  private bindLifecycleHandlers(connection: amqp.ChannelModel, channel: amqp.Channel): void {
    connection.on("error", (error) => {
      this.logLifecycleError("connection", error);
    });
    channel.on("error", (error) => {
      this.logLifecycleError("channel", error);
    });
    connection.on("close", () => {
      this.handleUnexpectedClose("connection", connection, channel);
    });
    channel.on("close", () => {
      this.handleUnexpectedClose("channel", connection, channel);
    });
  }

  private logLifecycleError(resource: "connection" | "channel", error: unknown): void {
    if (this.stopping) {
      return;
    }
    this.options.logger.error(
      {
        role: "amqp-document-job-consumer",
        queueName: this.options.queueName,
        resource,
        error: error instanceof Error ? error.message : String(error),
      },
      "AMQP document job consumer lifecycle error",
    );
  }

  private handleUnexpectedClose(
    resource: "connection" | "channel",
    connection: amqp.ChannelModel,
    channel: amqp.Channel,
  ): void {
    if (this.stopping) {
      return;
    }

    if (
      (resource === "connection" && this.connection !== connection)
      || (resource === "channel" && this.channel !== channel)
    ) {
      return;
    }

    this.options.logger.error(
      {
        role: "amqp-document-job-consumer",
        queueName: this.options.queueName,
        resource,
      },
      "AMQP document job consumer closed unexpectedly",
    );
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
    if (resource === "channel") {
      void closeQuietly(connection, this.options.logger, "amqp-document-job-consumer connection");
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.stopping || this.reconnecting || this.reconnectTimer) {
      return;
    }

    const delayMs = this.nextReconnectDelayMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectPromise = this.reconnect().finally(() => {
        this.reconnectPromise = null;
      });
    }, delayMs);
  }

  private nextReconnectDelayMs(): number {
    const initialDelayMs = Math.max(0, this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    const maxDelayMs = Math.max(initialDelayMs, this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS);
    const multiplier = Math.max(1, this.options.reconnectBackoffMultiplier ?? DEFAULT_RECONNECT_BACKOFF_MULTIPLIER);
    const delayMs = Math.min(initialDelayMs * multiplier ** this.reconnectAttempt, maxDelayMs);
    this.reconnectAttempt += 1;
    return delayMs;
  }

  private async reconnect(): Promise<void> {
    if (!this.running || this.stopping || this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    let retry = false;
    try {
      await this.openConsumer();
      this.reconnectAttempt = 0;
      this.options.logger.info(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
        },
        "AMQP document job consumer reconnected",
      );
    } catch (error) {
      this.options.logger.error(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
          error: error instanceof Error ? error.message : String(error),
        },
        "AMQP document job consumer reconnect failed",
      );
      retry = true;
    } finally {
      this.reconnecting = false;
      if (retry) {
        this.scheduleReconnect();
      }
    }
  }

  private async handleMessage(channel: amqp.Channel, message: amqp.ConsumeMessage | null): Promise<void> {
    if (!message) {
      return;
    }

    let jobId: string;
    try {
      const parsed = parseDocumentJobQueueMessage(JSON.parse(message.content.toString("utf8")));
      jobId = parsed.jobId;
    } catch (error) {
      this.options.logger.warn(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
          deadLetterQueueName: this.options.deadLetterQueueName,
          error: formatMessageError(error),
          rawPayloadBase64: message.content.toString("base64"),
        },
        "Rejected invalid document job queue message",
      );
      nackQuietly(channel, message, false, this.options.logger, this.options.queueName);
      return;
    }

    let result: "processed" | "noop" | "busy";
    try {
      result = await this.options.worker.runJobById(jobId);
    } catch (error) {
      this.options.logger.error(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Document job queue message handling failed",
      );
      await delay(this.options.busyRequeueDelayMs ?? DEFAULT_BUSY_REQUEUE_DELAY_MS);
      nackQuietly(channel, message, true, this.options.logger, this.options.queueName);
      return;
    }

    if (result === "busy") {
      await delay(this.options.busyRequeueDelayMs ?? DEFAULT_BUSY_REQUEUE_DELAY_MS);
      this.options.logger.info(
        {
          role: "amqp-document-job-consumer",
          queueName: this.options.queueName,
          jobId,
          result,
        },
        "Requeued busy document processing job message",
      );
      nackQuietly(channel, message, true, this.options.logger, this.options.queueName);
      return;
    }

    ackQuietly(channel, message, this.options.logger, this.options.queueName);
    this.options.logger.info(
      {
        role: "amqp-document-job-consumer",
        queueName: this.options.queueName,
        jobId,
        result,
      },
      "Handled document processing job message",
    );
  }
}

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const formatMessageError = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const closeQuietly = async (
  closeable: { close(): Promise<void> },
  logger: Pick<AppLogger, "warn">,
  resource: string,
): Promise<void> => {
  try {
    await closeable.close();
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        resource,
      },
      "Failed to close AMQP resource",
    );
  }
};

const ackQuietly = (
  channel: amqp.Channel,
  message: amqp.Message,
  logger: Pick<AppLogger, "warn">,
  queueName: string,
): void => {
  try {
    channel.ack(message);
  } catch (error) {
    logger.warn(
      {
        role: "amqp-document-job-consumer",
        queueName,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to acknowledge AMQP document job message",
    );
  }
};

const nackQuietly = (
  channel: amqp.Channel,
  message: amqp.Message,
  requeue: boolean,
  logger: Pick<AppLogger, "warn">,
  queueName: string,
): void => {
  try {
    channel.nack(message, false, requeue);
  } catch (error) {
    logger.warn(
      {
        role: "amqp-document-job-consumer",
        queueName,
        requeue,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to reject AMQP document job message",
    );
  }
};

const cancelQuietly = async (
  channel: amqp.Channel,
  consumerTag: string,
  logger: Pick<AppLogger, "warn">,
): Promise<void> => {
  try {
    await channel.cancel(consumerTag);
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        consumerTag,
      },
      "Failed to cancel AMQP consumer",
    );
  }
};
