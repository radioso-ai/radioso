import type { ConnectorRegistry } from "../services/connectorRegistry.js";
import { getSlackReadiness, type RequiredSlackEnvVar } from "../../slack/public.js";
import { SlackPlugin } from "./slack/slackPlugin.js";
import { WordpressConnector } from "./wordpress/wordpressConnector.js";
import { WhatsAppPlugin } from "./whatsapp/whatsappPlugin.js";

export interface BuiltInConnectorOptions {
  slack?: Partial<Record<RequiredSlackEnvVar, string | undefined>> & {
    signingSecret?: string;
    encryptionKey?: string;
  };
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
    }));
  }
};
