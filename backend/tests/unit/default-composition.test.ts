import { describe, expect, it, vi } from "vitest";

import { createDefaultApplicationComposition } from "../../src/app/composition/defaultComposition.js";
import type { ConnectorPlugin } from "@radioso/connector-api";

const createConnector = (id: string): ConnectorPlugin => ({
  id,
  name: id,
  description: `${id} connector`,
  configSchema: () => [],
  migrate: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getWebhookPath: () => `/api/connectors/${id}/webhook`,
  uniqueChannelField: () => null,
  validateConfig: () => [],
});

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("default application composition", () => {
  it("creates standalone default composition without optional modules", async () => {
    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
    });

    await expect(composition.capabilityPolicy.can({
      capability: "documents.delete",
      workspaceId: "workspace-1",
    })).resolves.toEqual({ allowed: true });
    expect(composition.connectors).toEqual([]);
    expect(composition.modules).toEqual([]);
  });

  it("applies optional connector contributions through module registration", async () => {
    const connector = createConnector("test-connector");
    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
      modules: [
        {
          id: "connector-module",
          register(context) {
            context.registerConnector(connector);
          },
        },
      ],
    });

    expect(composition.connectors).toEqual([connector]);
    expect(composition.modules.map((module) => module.id)).toEqual(["connector-module"]);
  });

  it("collects optional sink and adapter contributions through module registration", () => {
    const telemetrySink = { emit: vi.fn().mockResolvedValue(undefined) };
    const productAnalyticsSink = { emit: vi.fn().mockResolvedValue(undefined) };
    const incidentSink = { record: vi.fn().mockResolvedValue(undefined) };
    const websiteEmbedIntegration = {
      buildScriptUrl: vi.fn().mockReturnValue("https://widget.example.com/radioso-embed.js"),
      buildSnippet: vi.fn().mockReturnValue("<script></script>"),
    };
    const documentStorage = {
      upload: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
    };
    const documentJobDispatcher = {
      dispatch: vi.fn(),
      dispatchMany: vi.fn(),
    };

    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
      modules: [
        {
          id: "adapter-module",
          register(context) {
            context.registerTelemetrySink(telemetrySink);
            context.registerProductAnalyticsSink(productAnalyticsSink);
            context.registerIncidentSink(incidentSink);
            context.registerDocumentStorage(documentStorage);
            context.registerDocumentJobDispatcher(documentJobDispatcher);
            context.registerWebsiteEmbedIntegration(websiteEmbedIntegration);
          },
        },
      ],
    });

    expect(composition.telemetrySinks).toEqual([telemetrySink]);
    expect(composition.productAnalyticsSinks).toEqual([productAnalyticsSink]);
    expect(composition.incidentSinks).toEqual([incidentSink]);
    expect(composition.documentStorage).toBe(documentStorage);
    expect(composition.documentJobDispatcher).toBe(documentJobDispatcher);
    expect(composition.websiteEmbedIntegration).toBe(websiteEmbedIntegration);
  });
});
