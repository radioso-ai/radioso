import type { ConnectorRegistry } from "../services/connectorRegistry.js";
import { SlackPlugin } from "./slack/slackPlugin.js";
import { WordpressConnector } from "./wordpress/wordpressConnector.js";
import { WhatsAppPlugin } from "./whatsapp/whatsappPlugin.js";

export interface BuiltInConnectorOptions {
  slack?: {
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
  if (options.slack?.signingSecret) {
    registry.register(new SlackPlugin({
      signingSecret: options.slack.signingSecret,
      encryptionKey: options.slack.encryptionKey,
    }));
  }
};
