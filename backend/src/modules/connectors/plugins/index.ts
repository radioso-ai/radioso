import type { ConnectorRegistry } from "../services/connectorRegistry.js";
import { WordpressConnector } from "./wordpress/wordpressConnector.js";
import { WhatsAppPlugin } from "./whatsapp/whatsappPlugin.js";

/**
 * Registers the connector plugins that ship with the core application.
 * The app bootstrap depends on this catalog, not on individual plugin classes.
 */
export const registerBuiltInConnectors = (registry: ConnectorRegistry): void => {
  registry.register(new WordpressConnector());
  registry.register(new WhatsAppPlugin());
};
