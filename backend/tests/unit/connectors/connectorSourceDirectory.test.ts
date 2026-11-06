import { describe, expect, it, vi } from "vitest";

import { createConnectorSourceDirectory } from "../../../src/modules/connectors/services/connectorSourceDirectory.js";

describe("createConnectorSourceDirectory", () => {
  it("lists the workspace's connector sources under a prefix as registered sources", async () => {
    const listByKindAndExternalIdPrefix = vi.fn(async () => [
      {
        id: "source-1",
        workspaceId: "ws-1",
        kind: "connector" as const,
        name: "one.example.org",
        externalId: "wordpress:https://one.example.org",
        config: { siteUrl: "https://one.example.org" },
        metadata: { connectorId: "wordpress" },
        lastSyncStatus: null,
        lastSyncedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    const directory = createConnectorSourceDirectory({ listByKindAndExternalIdPrefix });

    const sources = await directory.listByExternalIdPrefix({ workspaceId: "ws-1", externalIdPrefix: "wordpress:" });

    expect(listByKindAndExternalIdPrefix).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      kind: "connector",
      externalIdPrefix: "wordpress:",
    });
    expect(sources).toEqual([
      {
        id: "source-1",
        source: {
          externalId: "wordpress:https://one.example.org",
          name: "one.example.org",
          config: { siteUrl: "https://one.example.org" },
          metadata: { connectorId: "wordpress" },
        },
      },
    ]);
  });
});
