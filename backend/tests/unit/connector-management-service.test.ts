import { describe, expect, it, vi } from "vitest";

import { ConnectorManagementService } from "../../src/modules/connectors/services/connectorManagementService.js";

describe("ConnectorManagementService", () => {
  it("owns the registry/database pairing so HTTP callers receive a management port", async () => {
    const database = { query: vi.fn() };
    const registry = {
      listConnectors: vi.fn().mockResolvedValue([{ id: "email" }]),
      getConnectorDetail: vi.fn().mockResolvedValue({ id: "email" }),
      getPlugin: vi.fn().mockReturnValue({ id: "email" }),
      saveConfig: vi.fn().mockResolvedValue({ kind: "success" }),
      enableConnector: vi.fn().mockResolvedValue({ kind: "success" }),
      disableConnector: vi.fn().mockResolvedValue(undefined),
      syncConnector: vi.fn().mockResolvedValue({ kind: "success", accepted: true }),
    };
    const service = new ConnectorManagementService({ database, registry });

    await expect(service.list("workspace-1")).resolves.toEqual([{ id: "email" }]);
    await expect(service.detail("workspace-1", "email")).resolves.toEqual({ id: "email" });
    expect(service.exists("email")).toBe(true);
    await expect(service.saveConfig("workspace-1", "email", { address: "help@example.com" }))
      .resolves.toEqual({ kind: "success" });
    await expect(service.enable("workspace-1", "email")).resolves.toEqual({ kind: "success" });
    await expect(service.disable("workspace-1", "email")).resolves.toBeUndefined();
    await expect(service.sync("workspace-1", "email")).resolves.toEqual({ kind: "success", accepted: true });

    expect(registry.listConnectors).toHaveBeenCalledWith(database, "workspace-1");
    expect(registry.getConnectorDetail).toHaveBeenCalledWith(database, "workspace-1", "email");
    expect(registry.getPlugin).toHaveBeenCalledWith("email");
    expect(registry.saveConfig).toHaveBeenCalledWith(database, "workspace-1", "email", { address: "help@example.com" });
    expect(registry.enableConnector).toHaveBeenCalledWith(database, "workspace-1", "email");
    expect(registry.disableConnector).toHaveBeenCalledWith(database, "workspace-1", "email");
    expect(registry.syncConnector).toHaveBeenCalledWith(database, "workspace-1", "email");
  });
});
