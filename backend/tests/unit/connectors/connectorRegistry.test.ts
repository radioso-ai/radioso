import { Router } from "express";
import { describe, expect, it } from "vitest";

import type { ConnectorPlugin, ConnectorContext } from "../../../src/modules/connectors/domain/connectorPlugin.js";
import type { ConfigFieldDefinition } from "../../../src/modules/connectors/domain/configSchema.js";
import { ConnectorRegistry } from "../../../src/modules/connectors/services/connectorRegistry.js";

/** Minimal fake plugin for testing the registry. */
const createFakePlugin = (overrides: Partial<ConnectorPlugin> = {}): ConnectorPlugin => ({
  id: overrides.id ?? "fake",
  name: overrides.name ?? "Fake Connector",
  description: overrides.description ?? "A test connector",
  configSchema: overrides.configSchema ?? (() => [
    { key: "api_key", label: "API Key", type: "secret", required: true },
    { key: "channel_id", label: "Channel ID", type: "text", required: true },
  ] satisfies ConfigFieldDefinition[]),
  migrate: overrides.migrate ?? (async () => {}),
  initialize: overrides.initialize ?? (async () => {}),
  shutdown: overrides.shutdown ?? (async () => {}),
  getWebhookPath: overrides.getWebhookPath ?? (() => "/api/connectors/fake/:workspaceId/webhook"),
  uniqueChannelField: overrides.uniqueChannelField ?? (() => "channel_id"),
  validateConfig: overrides.validateConfig ?? (() => []),
});

describe("ConnectorRegistry", () => {
  it("registers a plugin and lists it", () => {
    const registry = new ConnectorRegistry();
    const plugin = createFakePlugin();
    registry.register(plugin);

    const plugins = registry.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("fake");
    expect(plugins[0].name).toBe("Fake Connector");
  });

  it("throws when registering duplicate plugin id", () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ id: "dup" }));
    expect(() => registry.register(createFakePlugin({ id: "dup" }))).toThrow(/already registered/i);
  });

  it("retrieves a plugin by id", () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({ id: "alpha" }));
    registry.register(createFakePlugin({ id: "beta" }));

    expect(registry.getPlugin("alpha")?.id).toBe("alpha");
    expect(registry.getPlugin("beta")?.id).toBe("beta");
    expect(registry.getPlugin("gamma")).toBeUndefined();
  });

  it("runs migrations for all registered plugins", async () => {
    const migrated: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "a",
      migrate: async () => { migrated.push("a"); },
    }));
    registry.register(createFakePlugin({
      id: "b",
      migrate: async () => { migrated.push("b"); },
    }));

    await registry.runMigrations({} as any);
    expect(migrated).toEqual(["a", "b"]);
  });

  it("initializes and shuts down all registered plugins", async () => {
    const events: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "x",
      initialize: async () => { events.push("init-x"); },
      shutdown: async () => { events.push("shutdown-x"); },
    }));

    const context: ConnectorContext = {
      db: {} as any,
      logger: { info: () => {}, error: () => {}, warn: () => {}, child: () => ({}) } as any,
      chatService: {} as any,
      connectorRegistry: registry,
      router: Router(),
    };

    await registry.initializeAll(context);
    expect(events).toContain("init-x");

    await registry.shutdownAll();
    expect(events).toContain("shutdown-x");
  });

  it("continues initializing other plugins if one fails", async () => {
    const events: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(createFakePlugin({
      id: "fails",
      initialize: async () => { throw new Error("boom"); },
    }));
    registry.register(createFakePlugin({
      id: "succeeds",
      initialize: async () => { events.push("init-succeeds"); },
    }));

    const context: ConnectorContext = {
      db: {} as any,
      logger: { info: () => {}, error: () => {}, warn: () => {}, child: () => ({}) } as any,
      chatService: {} as any,
      connectorRegistry: registry,
      router: Router(),
    };

    // Should not throw
    await registry.initializeAll(context);
    expect(events).toContain("init-succeeds");
  });
});
