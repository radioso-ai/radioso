import { describe, expect, it, vi } from "vitest";

import {
  AgentWizardError,
  AgentWizardService,
  type CrawlerPort,
} from "./agentWizardService.js";

const createCrawler = (overrides: Partial<CrawlerPort> = {}): CrawlerPort => ({
  fetchPageWithScreenshot: vi.fn().mockResolvedValue({
    url: "https://example.com",
    title: "Example",
    text: "Example builds useful support software for complex customer workflows.",
    links: ["https://example.com/product", "https://example.com/contact"],
    screenshot: new Uint8Array([1, 2, 3]),
    faviconUrl: "https://example.com/favicon.ico",
  }),
  crawlSite: vi.fn().mockResolvedValue([
    {
      url: "https://example.com/product",
      title: "Product",
      text: "Product details, implementation guidance, and deployment information.",
      status: "success",
    },
  ]),
  ...overrides,
});

const createService = (overrides: {
  crawlerProvider?: CrawlerPort;
  complete?: ReturnType<typeof vi.fn>;
  fetchImpl?: typeof fetch;
  assertPublicWebsiteUrl?: (url: string) => Promise<void>;
  crawlerLimits?: { defaultLimit: number; maxLimit: number };
} = {}) => {
  const complete = overrides.complete ?? vi.fn().mockResolvedValue(JSON.stringify({
    agentName: "Example Support",
    customInstruction: "Help visitors understand Example's support software and deployment options.",
    greetingMessage: "Hi! I can help with questions about Example.",
    contentType: "marketing",
    chunkingStrategy: "structured_semantic",
    chunkingRationale: "The pages include structured product and deployment content.",
  }));

  const agentService = {
    create: vi.fn().mockResolvedValue({ id: "agent-1", name: "Example Support" }),
    update: vi.fn().mockResolvedValue({ id: "agent-1" }),
  };

  const service = new AgentWizardService({
    textGenerationClient: { complete },
    agentService,
    ingestionSettingsService: {
      updateForWorkspace: vi.fn().mockResolvedValue(undefined),
    },
    documentStorage: {
      upload: vi.fn().mockResolvedValue({ bucket: "logos", key: "logo-key" }),
    },
    websiteCrawlJobService: {
      enqueue: vi.fn().mockResolvedValue({ jobId: "crawl-1", sourceId: null }),
    },
    crawlerProvider: overrides.crawlerProvider ?? createCrawler(),
    assertPublicWebsiteUrl: overrides.assertPublicWebsiteUrl ?? (async () => {}),
    crawlerLimits: overrides.crawlerLimits ?? { defaultLimit: 100, maxLimit: 1000 },
    auditService: {
      record: vi.fn().mockResolvedValue(undefined),
    },
    fetchImpl: overrides.fetchImpl,
  });

  return { agentService, complete, service };
};

describe("AgentWizardService", () => {
  it("analyzes a website with crawled pages and LLM suggestions", async () => {
    const crawler = createCrawler();
    const { complete, service } = createService({ crawlerProvider: crawler });
    const events: string[] = [];

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
      accountId: "account-1",
      onProgress: (event) => events.push(event.step),
    });

    expect(result).toMatchObject({
      suggestedName: "Example Support",
      suggestedGreetingMessage: "Hi! I can help with questions about Example.",
      faviconUrl: "https://example.com/favicon.ico",
      sourceUrl: "https://example.com",
      pagesAnalyzed: [
        { url: "https://example.com", title: "Example" },
        { url: "https://example.com/product", title: "Product" },
      ],
      screenshotUnavailableReason: null,
    });
    expect(result.screenshotBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(crawler.fetchPageWithScreenshot).toHaveBeenCalledWith("https://example.com", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(crawler.crawlSite).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://example.com",
      includeBaseUrl: false,
      signal: expect.any(AbortSignal),
    }));
    expect(complete).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining(["crawling", "analyzing", "generating", "complete"]));
  });

  it("retries once when the LLM returns invalid JSON", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(JSON.stringify({
        agentName: "Retry Support",
        customInstruction: "Use the retry result.",
        greetingMessage: "Hi from retry.",
        contentType: "mixed",
        chunkingStrategy: "fixed_window",
        chunkingRationale: "Mostly prose.",
      }));
    const { service } = createService({ complete });

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.suggestedName).toBe("Retry Support");
    expect(result.suggestedChunkingStrategy.strategy).toBe("fixed_window");
  });

  it("asks the LLM to extract verified company contact paths", async () => {
    const { complete, service } = createService();

    await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    const prompt = complete.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("how visitors can contact the organization");
    expect(prompt).toContain("Do not invent contact details");
    expect(prompt).toContain("verified contact path");
  });

  it("regenerates instructions from a cached analysis without crawling again", async () => {
    const crawler = createCrawler();
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        agentName: "Example Support",
        customInstruction: "Original instruction.",
        greetingMessage: "Original greeting.",
        contentType: "mixed",
        chunkingStrategy: "structured_semantic",
        chunkingRationale: "Structured.",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        agentName: "Example Guide",
        customInstruction: "Fresh instruction.",
        greetingMessage: "Fresh greeting.",
        contentType: "mixed",
        chunkingStrategy: "fixed_window",
        chunkingRationale: "Fresh prose.",
      }));
    const { service } = createService({ crawlerProvider: crawler, complete });
    const initial = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    const regenerated = await service.regenerateInstructions({
      workspaceId: "workspace-1",
      analysisRunId: initial.analysisRunId,
    });

    expect(regenerated).toMatchObject({
      suggestedName: "Example Guide",
      suggestedCustomInstruction: "Fresh instruction.",
      suggestedGreetingMessage: "Fresh greeting.",
      suggestedChunkingStrategy: { strategy: "fixed_window" },
    });
    expect(crawler.fetchPageWithScreenshot).toHaveBeenCalledOnce();
    expect(crawler.crawlSite).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("classifies an unreachable site before calling the LLM", async () => {
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), {
        code: "ENOTFOUND",
      })),
      crawlSite: vi.fn().mockResolvedValue([]),
    });
    const complete = vi.fn();
    const { service } = createService({ crawlerProvider: crawler, complete });

    await expect(service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    })).rejects.toMatchObject({
      code: "site_unreachable",
      statusCode: 422,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("classifies sparse content before calling the LLM", async () => {
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Empty",
        text: "   ",
        links: [],
        screenshot: null,
        faviconUrl: null,
      }),
      crawlSite: vi.fn().mockResolvedValue([]),
    });
    const complete = vi.fn();
    const { service } = createService({ crawlerProvider: crawler, complete });

    const promise = service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    await expect(promise).rejects.toBeInstanceOf(AgentWizardError);
    await expect(promise).rejects.toMatchObject({
      code: "content_too_sparse",
      statusCode: 422,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("creates an agent even when favicon upload fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("favicon timeout")) as unknown as typeof fetch;
    const { agentService, service } = createService({ fetchImpl });

    const result = await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com",
        name: "Example Support",
        faviconUrl: "https://example.com/favicon.ico",
      },
    });

    expect(result).toEqual({ agentId: "agent-1", crawlJobId: "crawl-1" });
    expect(agentService.create).toHaveBeenCalledOnce();
    expect(agentService.update).not.toHaveBeenCalled();
  });

  it("clamps the crawl limit to the server-side max", async () => {
    const enqueue = vi.fn().mockResolvedValue({ jobId: "crawl-1", sourceId: null });
    const websiteCrawlJobService = { enqueue };
    const service = new AgentWizardService({
      textGenerationClient: { complete: vi.fn() },
      agentService: {
        create: vi.fn().mockResolvedValue({ id: "agent-1", name: "Example" }),
        update: vi.fn(),
      },
      ingestionSettingsService: { updateForWorkspace: vi.fn().mockResolvedValue(undefined) },
      documentStorage: { upload: vi.fn() },
      websiteCrawlJobService,
      crawlerProvider: createCrawler(),
      assertPublicWebsiteUrl: async () => {},
      crawlerLimits: { defaultLimit: 250, maxLimit: 500 },
      auditService: { record: vi.fn().mockResolvedValue(undefined) },
    });

    await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com",
        name: "Example",
      },
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 250 }));
  });

  it("rejects analysis of URLs that fail the public-host policy", async () => {
    const crawler = createCrawler();
    const assertPublicWebsiteUrl = vi.fn(async (url: string) => {
      if (url.includes("169.254")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const { service } = createService({ crawlerProvider: crawler, assertPublicWebsiteUrl });

    await expect(
      service.analyzeWebsite({
        url: "http://169.254.169.254/latest/meta-data/",
        workspaceId: "workspace-1",
        accountId: "account-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_url", statusCode: 400 });
    expect(crawler.fetchPageWithScreenshot).not.toHaveBeenCalled();
    expect(crawler.crawlSite).not.toHaveBeenCalled();
  });

  it("rejects non-http URLs at analysis", async () => {
    const crawler = createCrawler();
    const { service } = createService({ crawlerProvider: crawler });

    await expect(
      service.analyzeWebsite({
        url: "file:///etc/passwd",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_url", statusCode: 400 });
    expect(crawler.fetchPageWithScreenshot).not.toHaveBeenCalled();
  });

  it("rejects a private-network favicon URL during agent creation", async () => {
    const assertPublicWebsiteUrl = vi.fn(async (url: string) => {
      if (url.includes("169.254")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { agentService, service } = createService({ assertPublicWebsiteUrl, fetchImpl });

    await expect(
      service.createAgentFromWizard({
        workspaceId: "workspace-1",
        accountId: "account-1",
        config: {
          websiteUrl: "https://example.com",
          name: "Example Support",
          faviconUrl: "http://169.254.169.254/icon",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_url", statusCode: 400 });
    expect(agentService.create).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
