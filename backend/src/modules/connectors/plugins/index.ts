import type { ConnectorRegistry } from "../services/connectorRegistry.js";

/**
 * Registers the connector plugins that ship with the core application.
 * The app bootstrap depends on this catalog, not on individual plugin classes.
 */
export const registerBuiltInConnectors = (_registry: ConnectorRegistry): void => {};
