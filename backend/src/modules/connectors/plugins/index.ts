import type { ConnectorPlugin } from "@radioso/connector-api";

import type { ConnectorRegistry } from "../services/connectorRegistry.js";
import type { BackgroundJobQueue } from "../../../shared/background-jobs/index.js";
import type { FieldEncryptionKeys } from "../../../shared/infra/crypto/fieldEncryption.js";
import { getSlackReadiness, type RequiredSlackEnvVar } from "../../slack/public.js";
import { SlackPlugin } from "./slack/slackPlugin.js";
import { WordpressConnector } from "./wordpress/wordpressConnector.js";
import { WhatsAppPlugin } from "./whatsapp/whatsappPlugin.js";

export { createEmailChannelConnector, createEmailReviewChecks } from "./email/emailPlugin.js";
export type { EmailChannelWorker } from "./email/emailChannelWorker.js";
export { EMAIL_COALESCE_SECONDS, EMAIL_RAW_MAX_BYTES, type EmailThreadProtocolUnitOfWork } from "./email/emailInboundProcessor.js";
export { EMAIL_REVIEW_MAX_ATTEMPTS, type EmailReviewChecks } from "./email/emailReviewRunner.js";
export type { EmailReviewInferenceFactory } from "./email/emailReviewChecks.js";
// The worker-side Slack composition: builds the message handler `slack.inbound_event` jobs
// dispatch through. Unlike `SlackPlugin` (API-only, mounts HTTP routes), this runs in every
// runtime that drains background jobs.
export { buildSlackInboundJobComposition } from "./slack/slackInboundJobComposition.js";
export { SlackUserIdentityFinder } from "./slack/slackPersistence.js";
export { WhatsAppMessageLogEraser } from "./whatsapp/whatsappPersistence.js";

interface BuiltInConnectorOptions {
  slack?: Partial<Record<RequiredSlackEnvVar, string | undefined>> & {
    signingSecret?: string;
    encryptionKey?: FieldEncryptionKeys;
    /** The webhook's enqueue port. Required wherever the Slack connector actually registers. */
    backgroundJobs?: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">;
  };
  /** The email channel's plugin, built by its composition only when an email provider is configured. */
  email?: ConnectorPlugin | null;
}

/**
 * Registers the connector plugins that ship with the core application.
 * The app bootstrap depends on this catalog, not on individual plugin classes.
 */
export const registerBuiltInConnectors = (registry: ConnectorRegistry, options: BuiltInConnectorOptions = {}): void => {
  registry.register(new WordpressConnector());
  registry.register(new WhatsAppPlugin());
  if (getSlackReadiness({
    SLACK_OAUTH_CLIENT_ID: options.slack?.SLACK_OAUTH_CLIENT_ID,
    SLACK_OAUTH_CLIENT_SECRET: options.slack?.SLACK_OAUTH_CLIENT_SECRET,
    SLACK_SIGNING_SECRET: options.slack?.SLACK_SIGNING_SECRET ?? options.slack?.signingSecret,
  }).configured) {
    registry.register(new SlackPlugin({
      signingSecret: options.slack!.SLACK_SIGNING_SECRET ?? options.slack!.signingSecret!,
      encryptionKey: options.slack!.encryptionKey,
      backgroundJobs: options.slack!.backgroundJobs!,
    }));
  }
  if (options.email) {
    registry.register(options.email);
  }
};
