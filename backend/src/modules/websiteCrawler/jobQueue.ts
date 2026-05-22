import * as amqp from "amqplib";
import { CloudTasksClient } from "@google-cloud/tasks";
import { z } from "zod";

import type { AppLogger } from "../../shared/observability/logger.js";
import type { JobConsumerPort } from "../../shared/domain/jobConsumer.js";
import type {
  WebsiteCrawlJobDispatchRequest,
  WebsiteCrawlJobDispatcherPort,
} from "./jobDispatcher.js";

const WORKER_TASK_PATH = "/internal/tasks/website-crawl";

export const websiteCrawlJobQueueMessageSchema = z.object({
  jobId: z.string().uuid(),
  workspaceId: z.string().uuid(),
}).strict();

const buildCrawlMainQueueOptions = (deadLetterQueueName?: string): amqp.Options.AssertQueue => {
  const options: amqp.Options.AssertQueue = { durable: true };
  if (deadLetterQueueName) {
    options.deadLetterExchange = "";
    options.deadLetterRoutingKey = deadLetterQueueName;
  }
  return options;
};

const assertCrawlQueuesWithDlq = async (
  channel: amqp.Channel | amqp.ConfirmChannel,
  queueName: string,
  deadLetterQueueName: string | undefined,
): Promise<void> => {
  if (deadLetterQueueName) {
    await channel.assertQueue(deadLetterQueueName, { durable: true });
  }
  await channel.assertQueue(queueName, buildCrawlMainQueueOptions(deadLetterQueueName));
};

export type WebsiteCrawlJobQueueMessage = z.infer<typeof websiteCrawlJobQueueMessageSchema>;

export const toWebsiteCrawlJobQueueMessage = (
  input: WebsiteCrawlJobDispatchRequest,
): WebsiteCrawlJobQueueMessage => ({
  jobId: input.jobId,
  workspaceId: input.workspaceId,
});

export const parseWebsiteCrawlJobQueueMessage = (input: unknown): WebsiteCrawlJobQueueMessage =>
  websiteCrawlJobQueueMessageSchema.parse(input);

const toBase64Json = (input: unknown): string => Buffer.from(JSON.stringify(input), "utf8").toString("base64");
const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

export class CloudTasksWebsiteCrawlJobDispatcher implements WebsiteCrawlJobDispatcherPort {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly targetUrl: string;

  constructor(private readonly options: {
    client?: CloudTasksClient;
    projectId: string;
    location: string;
    queueName: string;
    workerServiceUrl: string;
    invokerServiceAccountEmail: string;
    logger: AppLogger;
  }) {
    this.client = options.client ?? new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queueName);
    this.targetUrl = `${normalizeUrl(options.workerServiceUrl)}${WORKER_TASK_PATH}`;
  }

  async dispatch(input: WebsiteCrawlJobDispatchRequest): Promise<void> {
    await this.client.createTask({
      parent: this.parent,
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: this.targetUrl,
          headers: {
            "Content-Type": "application/json",
          },
          body: toBase64Json(toWebsiteCrawlJobQueueMessage(input)),
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: this.targetUrl,
          },
        },
      },
    });

    this.options.logger.info(
      {
        role: "website-crawl-job-dispatcher",
        jobId: input.jobId,
        workspaceId: input.workspaceId,
      },
      "Dispatched website crawl job",
    );
  }
}

export class AmqpWebsiteCrawlJobDispatcher implements WebsiteCrawlJobDispatcherPort {
  private readonly connect: (url: string) => Promise<amqp.ChannelModel>;

  constructor(private readonly options: {
    amqpUrl: string;
    queueName: string;
    deadLetterQueueName?: string;
    connect?: (url: string) => Promise<amqp.ChannelModel>;
    logger: AppLogger;
  }) {
    this.connect = options.connect ?? amqp.connect;
  }

  async dispatch(input: WebsiteCrawlJobDispatchRequest): Promise<void> {
    let connection: amqp.ChannelModel | null = null;
    let channel: amqp.ConfirmChannel | null = null;

    try {
      connection = await this.connect(this.options.amqpUrl);
      channel = await connection.createConfirmChannel();
      await assertCrawlQueuesWithDlq(channel, this.options.queueName, this.options.deadLetterQueueName);
      channel.sendToQueue(
        this.options.queueName,
        Buffer.from(JSON.stringify(toWebsiteCrawlJobQueueMessage(input)), "utf8"),
        {
          contentType: "application/json",
          persistent: true,
          type: "website.crawl",
        },
      );
      await channel.waitForConfirms();
      this.options.logger.info(
        {
          role: "amqp-website-crawl-job-dispatcher",
          queueName: this.options.queueName,
          jobId: input.jobId,
          workspaceId: input.workspaceId,
        },
        "Dispatched website crawl job to AMQP queue",
      );
    } finally {
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  }
}

export class AmqpWebsiteCrawlJobConsumer implements JobConsumerPort {
  private readonly connect: (url: string) => Promise<amqp.ChannelModel>;
  private channel: amqp.Channel | null = null;
  private connection: amqp.ChannelModel | null = null;
  private consumerTag: string | null = null;
  private running = false;

  constructor(private readonly options: {
    amqpUrl: string;
    queueName: string;
    deadLetterQueueName?: string;
    connect?: (url: string) => Promise<amqp.ChannelModel>;
    logger: AppLogger;
    worker: {
      runJobById(jobId: string): Promise<"processed" | "noop" | "busy">;
    };
  }) {
    this.connect = options.connect ?? amqp.connect;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      this.connection = await this.connect(this.options.amqpUrl);
      this.channel = await this.connection.createChannel();
      await assertCrawlQueuesWithDlq(this.channel, this.options.queueName, this.options.deadLetterQueueName);
      await this.channel.prefetch(1);
      const consumer = await this.channel.consume(this.options.queueName, (message) => {
        void this.handleMessage(message);
      });
      this.consumerTag = consumer.consumerTag;
      this.options.logger.info(
        { role: "amqp-website-crawl-job-consumer", queueName: this.options.queueName },
        "AMQP website crawl job consumer started",
      );
    } catch (error) {
      this.options.logger.error(
        {
          role: "amqp-website-crawl-job-consumer",
          queueName: this.options.queueName,
          error: error instanceof Error ? error.message : String(error),
        },
        "AMQP website crawl job consumer startup failed; database polling remains active",
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
    }
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
  }

  private async handleMessage(message: amqp.ConsumeMessage | null): Promise<void> {
    if (!message || !this.channel) {
      return;
    }
    let jobId: string;
    try {
      const parsed = parseWebsiteCrawlJobQueueMessage(JSON.parse(message.content.toString("utf8")));
      jobId = parsed.jobId;
    } catch (error) {
      this.options.logger.warn(
        {
          role: "amqp-website-crawl-job-consumer",
          queueName: this.options.queueName,
          deadLetterQueueName: this.options.deadLetterQueueName,
          error: error instanceof Error ? error.message : String(error),
          rawPayloadBase64: message.content.toString("base64"),
        },
        "Rejected invalid website crawl queue message",
      );
      this.channel.nack(message, false, false);
      return;
    }

    try {
      const result = await this.options.worker.runJobById(jobId);
      if (result === "busy") {
        this.channel.nack(message, false, true);
        return;
      }
      this.channel.ack(message);
    } catch (error) {
      this.options.logger.error(
        {
          role: "amqp-website-crawl-job-consumer",
          queueName: this.options.queueName,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Website crawl queue message handling failed",
      );
      this.channel.nack(message, false, true);
    }
  }
}
