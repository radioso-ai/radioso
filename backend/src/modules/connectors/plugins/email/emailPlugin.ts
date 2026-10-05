import type {
  ConfigFieldDefinition,
  ConnectorChatPort,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import type { EmailChannelSweep, EmailInboundRepository } from "../../../emailChannel/public.js";
import type { InboundEmailReceiver } from "../../../mail/public.js";
import { EmailChannelWorker } from "./emailChannelWorker.js";
import { EmailInboundProcessor, type EmailInboundProcessorDependencies } from "./emailInboundProcessor.js";
import { ModelEmailReplyCompleteness, type EmailReviewGroundingReader } from "./emailReplyCompleteness.js";
import { ModelEmailReplyTriage } from "./emailReplyTriage.js";
import type { EmailReviewCheckDependencies } from "./emailReviewChecks.js";
import { EmailReviewRunner, type EmailReviewChecks, type EmailReviewRunnerDependencies } from "./emailReviewRunner.js";
import { createEmailWebhookRouter, type EmailWebhookRouterOptions } from "./emailWebhook.js";

interface EmailChannelConnectorDependencies
  extends Omit<EmailInboundProcessorDependencies, "receiver" | "inbound" | "mailboxes" | "domains" | "threads" | "chat" | "logger"> {
  receiver: Pick<InboundEmailReceiver, "provider" | "verify" | "fetchMessage">;
  inbound: EmailInboundProcessorDependencies["inbound"] & Pick<EmailInboundRepository, "insertEvent" | "claimDueEvents">;
  mailboxes: EmailInboundProcessorDependencies["mailboxes"] & EmailReviewRunnerDependencies["mailboxes"];
  domains: EmailInboundProcessorDependencies["domains"] & EmailReviewRunnerDependencies["domains"];
  threads: EmailInboundProcessorDependencies["threads"] & EmailReviewRunnerDependencies["links"];
  /** The host port: `ingest` records inbound mail (stage 1), `respond` runs its review (stage 2). */
  chat: Pick<ConnectorChatPort, "ingest" | "respond">;
  /** Stage 2's own ports, and `EMAIL_CHANNEL_REVIEW_MAX_ATTEMPTS`. */
  review: Pick<EmailReviewRunnerDependencies, "conversations" | "heldReplies" | "handoffs" | "checks" | "notes"> & { maxAttempts: number };
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  /** `EMAIL_CHANNEL_WORKERS_ENABLED`. */
  workersEnabled: boolean;
  sweep: Pick<EmailChannelSweep, "run" | "reconcileSends">;
}

/**
 * The email channel's connector side: the webhook plugin and the worker that drains what the
 * webhook persists — stage 1 over the inbound repository, stage 2 over the threads it schedules
 * reviews on — through the same drain dispatcher.
 */
export const createEmailChannelConnector = (
  deps: EmailChannelConnectorDependencies,
): { plugin: EmailPlugin; worker: EmailChannelWorker } => ({
  plugin: new EmailPlugin({ receiver: deps.receiver, events: deps.inbound, drains: deps.drains, metrics: deps.metrics, clock: deps.clock }),
  worker: new EmailChannelWorker({
    enabled: deps.workersEnabled,
    events: deps.inbound,
    processor: new EmailInboundProcessor(deps),
    reviews: new EmailReviewRunner({
      links: deps.threads,
      mailboxes: deps.mailboxes,
      domains: deps.domains,
      conversations: deps.review.conversations,
      chat: deps.chat,
      heldReplies: deps.review.heldReplies,
      handoffs: deps.review.handoffs,
      checks: deps.review.checks,
      notes: deps.review.notes,
      drains: deps.drains,
      metrics: deps.metrics,
      logger: deps.logger,
      clock: deps.clock,
      config: { supportedModes: deps.config.supportedModes, maxAttempts: deps.review.maxAttempts },
    }),
    sweep: deps.sweep,
    logger: deps.logger,
  }),
});

/**
 * The review's model checks over the structured inference composition hands in: the reply triage
 * before a turn and the completeness check before an automatic send. One object, read by the runner
 * on each call.
 */
export const createEmailReviewChecks = (
  deps: EmailReviewCheckDependencies & { grounding: EmailReviewGroundingReader },
): EmailReviewChecks => ({
  replyTriage: new ModelEmailReplyTriage(deps),
  replyCompleteness: new ModelEmailReplyCompleteness(deps),
});

/**
 * The email channel as a connector: its one HTTP surface, the provider webhook. The channel's
 * composition builds it, through `createEmailChannelConnector`, only when a provider is configured.
 */
export class EmailPlugin implements ConnectorPlugin {
  readonly id = "email";
  readonly name = "Email";
  readonly description = "Receive a support mailbox's email in the Radioso inbox.";

  private initialized = false;

  constructor(private readonly options: Omit<EmailWebhookRouterOptions, "logger">) {}

  configSchema(): ConfigFieldDefinition[] {
    return [];
  }

  async migrate(): Promise<void> {
    // Email channel tables are created by numbered backend migrations from 209.
  }

  async initialize(context: ConnectorContext): Promise<void> {
    if (this.initialized) {
      return;
    }
    // The router reads the raw body the host captures; the signature is computed over it.
    context.http.mount("/", createEmailWebhookRouter({ ...this.options, logger: context.logger }));
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  getWebhookPath(): string {
    return "/api/connectors/email/webhook";
  }

  uniqueChannelField(): string | null {
    return null;
  }

  validateConfig(): ConnectorValidationIssue[] {
    return [];
  }
}
