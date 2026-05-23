import { describe, expect, it, vi } from "vitest";

import {
  createDefaultApplicationComposition,
  createDefaultDocumentJobConsumer,
  createDefaultDocumentJobDispatcher,
  createDefaultWebsiteCrawlJobConsumer,
  createDefaultWebsiteCrawlJobDispatcher,
} from "../../src/app/composition/defaultComposition.js";
import { AmqpDocumentJobConsumer, AmqpDocumentJobDispatcher } from "../../src/modules/documents/infra/amqpDocumentJobQueue.js";
import { NoopDocumentJobDispatcher } from "../../src/modules/documents/services/documentJobDispatcher.js";
import { CloudTasksWebsiteCrawlJobDispatcher, AmqpWebsiteCrawlJobDispatcher } from "../../src/modules/websiteCrawler/jobQueue.js";
import { AmqpWebsiteCrawlJobConsumer } from "../../src/modules/websiteCrawler/jobQueue.js";
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
    expect(composition.skillCatalogRegistry.get("retrieval.answer")).toMatchObject({
      name: "retrieval.answer",
    });
    expect(composition.connectors).toEqual([]);
    expect(composition.websiteCrawlerProvider).toBeUndefined();
    expect(composition.modules.map((module) => module.id)).toEqual([
      "radioso-answer-feedback",
      "radioso-website-embed",
      "radioso-agent-wizard",
    ]);
    expect(composition.routeMounts.map((mount) => mount.path)).toContain("/api/v1/answer-feedback");
    expect(composition.answerFeedbackHistoryProviderRegistration).toBeTypeOf("function");
    expect(composition.agentSurfaceExtensions.map((extension) => extension.key)).toEqual(["websiteEmbed"]);
    expect(composition.websiteEmbedIntegration).toBeDefined();
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
    expect(composition.modules.map((module) => module.id)).toEqual([
      "radioso-answer-feedback",
      "radioso-website-embed",
      "radioso-agent-wizard",
      "connector-module",
    ]);
  });

  it("applies optional skill catalog entries through module registration", () => {
    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
      modules: [
        {
          id: "skill-module",
          register(context) {
            context.registerSkillCatalogEntry({
              name: "custom.workflow",
              displayName: "Custom workflow",
              description: "Run a custom workflow supplied by an optional module.",
              owner: "platform",
              executionClass: "interactive",
              supportedCallers: ["sdk"],
              requiredCapabilities: [],
              contractReferences: [
                {
                  kind: "documentation",
                  label: "Custom workflow documentation",
                  path: "docs/custom-workflow.md",
                },
              ],
              diagnostics: {
                defined: true,
                shapeAware: false,
                strategyAware: false,
              },
            });
          },
        },
      ],
    });

    expect(composition.skillCatalogRegistry.get("custom.workflow")).toMatchObject({
      name: "custom.workflow",
      owner: "platform",
    });
  });

  it("applies optional skill definitions through module registration", () => {
    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
      modules: [
        {
          id: "skill-definition-module",
          register(context) {
            context.registerSkillDefinition({
              name: "custom.defined_workflow",
              displayName: "Custom defined workflow",
              description: "Run a custom workflow supplied by an optional module.",
              owner: "platform",
              executionClass: "interactive",
              supportedCallers: ["sdk"],
              requiredCapabilities: [],
              contractReferences: [],
              diagnostics: {
                defined: true,
                shapeAware: true,
                strategyAware: false,
              },
              steps: [
                {
                  name: "step_one",
                  kind: "step_one",
                  clauses: {
                    enabled: true,
                  },
                },
              ],
              shapes: [
                {
                  name: "default",
                  stepOverrides: {},
                },
              ],
            });
          },
        },
      ],
    });

    expect(composition.skillCatalogRegistry.get("custom.defined_workflow")).toMatchObject({
      name: "custom.defined_workflow",
      owner: "platform",
      steps: [
        {
          name: "step_one",
          kind: "step_one",
        },
      ],
      shapes: [
        {
          name: "default",
        },
      ],
    });
  });

  it("collects optional sink and adapter contributions through module registration", () => {
    const telemetrySink = { emit: vi.fn().mockResolvedValue(undefined) };
    const productAnalyticsSink = { emit: vi.fn().mockResolvedValue(undefined) };
    const errorSink = { record: vi.fn().mockResolvedValue(undefined) };
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
    const websiteCrawlerProvider = {
      name: "test-crawler",
      crawl: vi.fn(),
    };
    const chunkingProvider = {
      name: "test-chunker",
      chunkText: vi.fn(),
    };

    const composition = createDefaultApplicationComposition({
      logger: createLogger(),
      modules: [
        {
          id: "adapter-module",
          register(context) {
            context.registerTelemetrySink(telemetrySink);
            context.registerProductAnalyticsSink(productAnalyticsSink);
            context.registerErrorSink(errorSink);
            context.registerDocumentStorage(documentStorage);
            context.registerDocumentJobDispatcher(documentJobDispatcher);
            context.registerWebsiteCrawlerProvider(websiteCrawlerProvider);
            context.registerChunkingProvider(chunkingProvider);
            context.registerWebsiteEmbedIntegration(websiteEmbedIntegration);
          },
        },
      ],
    });

    expect(composition.telemetrySinks).toEqual([telemetrySink]);
    expect(composition.productAnalyticsSinks).toEqual([productAnalyticsSink]);
    expect(composition.errorSinks).toEqual([errorSink]);
    expect(composition.documentStorage).toBe(documentStorage);
    expect(composition.documentJobDispatcher).toBe(documentJobDispatcher);
    expect(composition.websiteCrawlerProvider).toBe(websiteCrawlerProvider);
    expect(composition.chunkingProvider).toBe(chunkingProvider);
    expect(composition.websiteEmbedIntegration).toBe(websiteEmbedIntegration);
  });

  it("selects the no-op document dispatcher by default", () => {
    const dispatcher = createDefaultDocumentJobDispatcher({
      WORKER_DISPATCH_DRIVER: "noop",
      GOOGLE_CLOUD_PROJECT: undefined,
      WORKER_TASKS_QUEUE_LOCATION: undefined,
      WORKER_TASKS_QUEUE_NAME: undefined,
      WORKER_TASKS_SERVICE_URL: undefined,
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
      WORKER_AMQP_URL: undefined,
      WORKER_AMQP_QUEUE_NAME: undefined,
      WORKER_AMQP_PREFETCH: 1,
    }, createLogger() as any);

    expect(dispatcher).toBeInstanceOf(NoopDocumentJobDispatcher);
  });

  it("selects AMQP document queue adapters when AMQP dispatch is configured", () => {
    const env = {
      WORKER_DISPATCH_DRIVER: "amqp" as const,
      GOOGLE_CLOUD_PROJECT: undefined,
      WORKER_TASKS_QUEUE_LOCATION: undefined,
      WORKER_TASKS_QUEUE_NAME: undefined,
      WORKER_TASKS_SERVICE_URL: undefined,
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
      WORKER_AMQP_URL: "amqp://localhost:5672",
      WORKER_AMQP_QUEUE_NAME: "radioso-document-jobs",
      WORKER_AMQP_PREFETCH: 2,
    };
    const logger = createLogger() as any;

    const dispatcher = createDefaultDocumentJobDispatcher(env, logger);
    const consumer = createDefaultDocumentJobConsumer(env, logger, {
      runJobById: vi.fn(),
    });

    expect(dispatcher).toBeInstanceOf(AmqpDocumentJobDispatcher);
    expect(consumer).toBeInstanceOf(AmqpDocumentJobConsumer);
  });

  it("falls back to the document queue for crawler tasks when crawl queue names are absent (cloud-tasks)", () => {
    const dispatcher = createDefaultWebsiteCrawlJobDispatcher({
      WORKER_DISPATCH_DRIVER: "cloud-tasks",
      GOOGLE_CLOUD_PROJECT: "radioso-test",
      WORKER_TASKS_QUEUE_LOCATION: "us-central1",
      WORKER_TASKS_QUEUE_NAME: "radioso-document-jobs",
      WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
      WORKER_TASKS_SERVICE_URL: "https://backend.example.com",
      WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "radioso-invoker@example.com",
      WORKER_AMQP_URL: undefined,
      WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
      WORKER_AMQP_QUEUE_NAME: undefined,
    }, createLogger() as any);

    expect(dispatcher).toBeInstanceOf(CloudTasksWebsiteCrawlJobDispatcher);
  });

  it("uses WORKER_TASKS_CRAWL_SERVICE_URL when set so cloud-tasks reach the dedicated crawler worker", async () => {
    const createTask = vi.fn().mockResolvedValue([{ name: "task" }]);
    const fakeClient = {
      queuePath: (project: string, location: string, queue: string) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
      createTask,
    } as never;

    const dispatcher = new CloudTasksWebsiteCrawlJobDispatcher({
      client: fakeClient,
      projectId: "radioso-test",
      location: "us-central1",
      queueName: "radioso-website-crawls",
      workerServiceUrl: "https://crawler-worker.example.com",
      invokerServiceAccountEmail: "radioso-invoker@example.com",
      logger: createLogger() as any,
    });

    await dispatcher.dispatch({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0].task.httpRequest.url).toBe(
      "https://crawler-worker.example.com/internal/tasks/website-crawl",
    );
  });

  it("composition forwards WORKER_TASKS_CRAWL_SERVICE_URL to the crawl dispatcher when defined", async () => {
    const createTask = vi.fn().mockResolvedValue([{ name: "task" }]);
    const fakeClient = {
      queuePath: (project: string, location: string, queue: string) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
      createTask,
    } as never;
    const originalCloudTasks = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = ""; // not used; just ensure no-op

    try {
      const dispatcher = createDefaultWebsiteCrawlJobDispatcher({
        WORKER_DISPATCH_DRIVER: "cloud-tasks",
        GOOGLE_CLOUD_PROJECT: "radioso-test",
        WORKER_TASKS_QUEUE_LOCATION: "us-central1",
        WORKER_TASKS_QUEUE_NAME: "radioso-document-jobs",
        WORKER_TASKS_CRAWL_QUEUE_NAME: "radioso-website-crawls",
        WORKER_TASKS_SERVICE_URL: "https://document-worker.example.com",
        WORKER_TASKS_CRAWL_SERVICE_URL: "https://crawler-worker.example.com",
        WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "radioso-invoker@example.com",
        WORKER_AMQP_URL: undefined,
        WORKER_AMQP_QUEUE_NAME: undefined,
        WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
      }, createLogger() as any);

      // The composition factory builds with the GCP client by default; replace
      // the underlying client by reaching into the dispatcher only for this test.
      (dispatcher as unknown as { client: typeof fakeClient }).client = fakeClient;

      await dispatcher.dispatch({
        jobId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
      });

      expect(createTask.mock.calls[0][0].task.httpRequest.url).toBe(
        "https://crawler-worker.example.com/internal/tasks/website-crawl",
      );
    } finally {
      if (originalCloudTasks === undefined) {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCloudTasks;
      }
    }
  });

  it("composition falls back to WORKER_TASKS_SERVICE_URL when no crawl-specific URL is set", async () => {
    const createTask = vi.fn().mockResolvedValue([{ name: "task" }]);
    const fakeClient = {
      queuePath: (project: string, location: string, queue: string) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
      createTask,
    } as never;

    const dispatcher = createDefaultWebsiteCrawlJobDispatcher({
      WORKER_DISPATCH_DRIVER: "cloud-tasks",
      GOOGLE_CLOUD_PROJECT: "radioso-test",
      WORKER_TASKS_QUEUE_LOCATION: "us-central1",
      WORKER_TASKS_QUEUE_NAME: "radioso-document-jobs",
      WORKER_TASKS_CRAWL_QUEUE_NAME: "radioso-website-crawls",
      WORKER_TASKS_SERVICE_URL: "https://document-worker.example.com",
      WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "radioso-invoker@example.com",
      WORKER_AMQP_URL: undefined,
      WORKER_AMQP_QUEUE_NAME: undefined,
      WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
    }, createLogger() as any);

    (dispatcher as unknown as { client: typeof fakeClient }).client = fakeClient;

    await dispatcher.dispatch({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    });

    expect(createTask.mock.calls[0][0].task.httpRequest.url).toBe(
      "https://document-worker.example.com/internal/tasks/website-crawl",
    );
  });

  it("falls back to the document queue for crawler tasks when crawl AMQP queue is absent", () => {
    const dispatcher = createDefaultWebsiteCrawlJobDispatcher({
      WORKER_DISPATCH_DRIVER: "amqp",
      GOOGLE_CLOUD_PROJECT: undefined,
      WORKER_TASKS_QUEUE_LOCATION: undefined,
      WORKER_TASKS_QUEUE_NAME: undefined,
      WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
      WORKER_TASKS_SERVICE_URL: undefined,
      WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
      WORKER_AMQP_URL: "amqp://localhost:5672",
      WORKER_AMQP_QUEUE_NAME: "radioso-document-jobs",
      WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
    }, createLogger() as any);
    const consumer = createDefaultWebsiteCrawlJobConsumer({
      WORKER_DISPATCH_DRIVER: "amqp",
      WORKER_AMQP_URL: "amqp://localhost:5672",
      WORKER_AMQP_QUEUE_NAME: "radioso-document-jobs",
      WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
    }, createLogger() as any, {
      runJobById: vi.fn(),
    });

    expect(dispatcher).toBeInstanceOf(AmqpWebsiteCrawlJobDispatcher);
    expect(consumer).toBeInstanceOf(AmqpWebsiteCrawlJobConsumer);
  });
});
