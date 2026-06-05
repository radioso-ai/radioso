import { describe, expect, it, vi } from "vitest";

import {
  AgentWizardError,
  AgentWizardService,
  type AgentWizardTextGenerationPort,
  type CrawlerPort,
} from "../../src/modules/agentWizard/service.js";

type CompleteMock = ReturnType<typeof vi.fn<AgentWizardTextGenerationPort["complete"]>>;

const createCrawler = (overrides: Partial<CrawlerPort> = {}): CrawlerPort => ({
  fetchPageWithScreenshot: vi.fn().mockResolvedValue({
    url: "https://example.com",
    title: "Example",
    text: "Example builds useful support software for complex customer workflows.",
    links: ["https://example.com/product", "https://example.com/contact", "https://example.com/privacy"],
    screenshot: new Uint8Array([1, 2, 3]),
    faviconUrl: "https://example.com/favicon.ico",
  }),
  crawlSite: vi.fn().mockResolvedValue([
    {
      url: "https://example.com/product",
      title: "Product",
      text: "Product details, implementation guidance, and deployment information. Contact support@example.com for help.",
      status: "success",
      links: ["https://example.com/privacy", "https://cdn.example.net/privacy"],
    },
  ]),
  isBrowserTransportAvailable: vi.fn().mockResolvedValue(true),
  ...overrides,
});

const createService = (overrides: {
  crawlerProvider?: CrawlerPort;
  complete?: CompleteMock;
  fetchImpl?: typeof fetch;
  assertPublicWebsiteUrl?: (url: string) => Promise<void>;
  crawlerLimits?: { defaultLimit: number; maxLimit: number };
} = {}) => {
  const complete = overrides.complete ?? vi.fn<AgentWizardTextGenerationPort["complete"]>().mockResolvedValue(JSON.stringify({
    agentName: "Example Support",
    customInstruction: "Help visitors understand Example's support software and deployment options.",
    greetingMessage: "Hi! I can help with questions about Example.",
    contentType: "marketing",
    chunkingStrategy: "structured_semantic",
    chunkingRationale: "The pages include structured product and deployment content.",
    language: "en-US",
    privacyPolicyUrl: "https://example.com/privacy",
    contactEmail: "support@example.com",
  }));

  const agentService = {
    create: vi.fn().mockResolvedValue({ id: "agent-1", name: "Example Support" }),
    update: vi.fn().mockResolvedValue({ id: "agent-1" }),
  };
  const documentStorage = {
    upload: vi.fn().mockResolvedValue({ bucket: "logos", objectPath: "logo-key", sizeBytes: 128 }),
  };
  const auditService = {
    record: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AgentWizardService({
    textGenerationClient: { complete },
    agentService,
    documentStorage,
    websiteCrawlJobService: {
      enqueue: vi.fn().mockResolvedValue({ jobId: "crawl-1", sourceId: null }),
    },
    crawlerProvider: overrides.crawlerProvider ?? createCrawler(),
    assertPublicWebsiteUrl: overrides.assertPublicWebsiteUrl ?? (async () => {}),
    crawlerLimits: overrides.crawlerLimits ?? { defaultLimit: 100, maxLimit: 1000 },
    auditService,
    fetchImpl: overrides.fetchImpl,
  });

  return { agentService, auditService, complete, documentStorage, service };
};

const faviconResponse = (input: {
  ok: boolean;
  status: number;
  contentType?: string | null;
  body?: number[];
  location?: string | null;
}) => ({
  ok: input.ok,
  status: input.status,
  headers: {
    get: (name: string) => {
      if (name.toLowerCase() === "content-type") return input.contentType ?? null;
      if (name.toLowerCase() === "location") return input.location ?? null;
      return null;
    },
  },
  arrayBuffer: async () => new Uint8Array(input.body ?? []).buffer,
});

describe("AgentWizardService", () => {
  it("analyzes a website with crawled pages and LLM suggestions", async () => {
    const crawler = createCrawler();
    const { auditService, complete, service } = createService({ crawlerProvider: crawler });
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
      suggestedLocale: "en-US",
      suggestedPrivacyPolicyUrl: "https://example.com/privacy",
      suggestedContactEmail: "support@example.com",
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
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent_wizard.analyze_website",
      metadata: expect.objectContaining({
        detectedLocale: true,
        detectedPrivacyPolicy: true,
        detectedContactEmail: true,
      }),
    }));
    expect(events).toEqual(expect.arrayContaining(["crawling", "analyzing", "generating", "complete"]));
  });

  it("retries once when the LLM returns invalid JSON", async () => {
    const complete = vi.fn<AgentWizardTextGenerationPort["complete"]>()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(JSON.stringify({
        agentName: "Retry Support",
        customInstruction: "Use the retry result.",
        greetingMessage: "Hi from retry.",
        contentType: "mixed",
        chunkingStrategy: "fixed_window",
        chunkingRationale: "Mostly prose.",
        language: "fr",
        privacyPolicyUrl: "https://example.com/privacy",
        contactEmail: "bonjour@example.com",
      }));
    const { service } = createService({ complete });

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.suggestedName).toBe("Retry Support");
    expect(result.suggestedChunkingStrategy.strategy).toBe("fixed_window");
    expect(result.suggestedLocale).toBe("fr");
  });

  it("treats missing optional LLM-derived wizard fields as null", async () => {
    const complete = vi.fn<AgentWizardTextGenerationPort["complete"]>().mockResolvedValue(JSON.stringify({
      agentName: "Legacy Support",
      customInstruction: "Use the legacy result.",
      greetingMessage: "Hi from legacy.",
      contentType: "mixed",
      chunkingStrategy: "structured_semantic",
      chunkingRationale: "Structured content.",
    }));
    const { service } = createService({ complete });

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(result.suggestedLocale).toBeNull();
    expect(result.suggestedPrivacyPolicyUrl).toBeNull();
    expect(result.suggestedContactEmail).toBeNull();
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

  it("passes same-origin candidate links to the LLM without keyword filtering", async () => {
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example",
        text: "Example helps support teams resolve customer questions across many channels. ".repeat(20),
        links: [
          "https://example.com/datenschutz",
          "https://example.com/contact",
          "https://other.example/privacy",
          "mailto:support@example.com",
        ],
        screenshot: null,
        faviconUrl: null,
      }),
      crawlSite: vi.fn().mockResolvedValue([
        {
          url: "https://example.com/datenschutz",
          title: "Datenschutz",
          text: "Datenschutz information and support@example.com contact details.",
          status: "success",
          links: ["https://example.com/impressum", "https://other.example/legal"],
        },
      ]),
    });
    const { complete, service } = createService({ crawlerProvider: crawler });

    await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    const prompt = complete.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("<candidate_links>");
    expect(prompt).toContain("https://example.com/datenschutz");
    expect(prompt).toContain("https://example.com/contact");
    expect(prompt).toContain("https://example.com/impressum");
    expect(prompt).not.toContain("https://other.example/privacy");
    expect(prompt).not.toContain("mailto:support@example.com");
  });

  it("drops hallucinated privacy URLs, invalid locales, and invalid contact emails", async () => {
    const complete = vi.fn<AgentWizardTextGenerationPort["complete"]>().mockResolvedValue(JSON.stringify({
      agentName: "Example Support",
      customInstruction: "Help visitors understand Example.",
      greetingMessage: "Hi! I can help with Example.",
      contentType: "marketing",
      chunkingStrategy: "structured_semantic",
      chunkingRationale: "Structured content.",
      language: "not a locale",
      privacyPolicyUrl: "https://example.com/not-crawled",
      contactEmail: "not an email",
    }));
    const { service } = createService({ complete });

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(result.suggestedLocale).toBeNull();
    expect(result.suggestedPrivacyPolicyUrl).toBeNull();
    expect(result.suggestedContactEmail).toBeNull();
  });

  it("skips the browser transport when Playwright is not available", async () => {
    const fetchPageWithScreenshot = vi.fn();
    const longText = "Example helps support teams resolve customer questions across many channels. ".repeat(20);
    const crawler = createCrawler({
      isBrowserTransportAvailable: vi.fn().mockResolvedValue(false),
      fetchPageWithScreenshot,
      crawlSite: vi.fn().mockResolvedValue([
        {
          url: "https://example.com",
          title: "Example",
          text: longText,
          status: "success",
          links: [],
        },
      ]),
    });
    const { service } = createService({ crawlerProvider: crawler });

    const result = await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(fetchPageWithScreenshot).not.toHaveBeenCalled();
    expect(crawler.isBrowserTransportAvailable).toHaveBeenCalled();
    expect(result.screenshotUnavailableReason).toBe("browser_unavailable");
  });

  it("classifies an unreachable site before calling the LLM", async () => {
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), {
        code: "ENOTFOUND",
      })),
      crawlSite: vi.fn().mockResolvedValue([]),
    });
    const complete = vi.fn<AgentWizardTextGenerationPort["complete"]>();
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
    const complete = vi.fn<AgentWizardTextGenerationPort["complete"]>();
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

  it("falls back to origin favicon.ico when the declared favicon is not an allowed raster image", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(faviconResponse({
        ok: true,
        status: 200,
        contentType: "image/svg+xml",
        body: [60, 115, 118, 103, 62],
      }))
      .mockResolvedValueOnce(faviconResponse({
        ok: true,
        status: 200,
        contentType: "image/x-icon",
        body: [1, 2, 3],
      })) as unknown as typeof fetch;
    const { agentService, service } = createService({ fetchImpl });

    await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com/docs",
        name: "Example Support",
        faviconUrl: "https://cdn.example.com/icon.svg",
      },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://cdn.example.com/icon.svg", expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://example.com/favicon.ico", expect.any(Object));
    expect(agentService.update).toHaveBeenCalledWith("workspace-1", "agent-1", {
      logo: expect.objectContaining({
        filename: "favicon.ico",
        mimeType: "image/x-icon",
      }),
    });
  });

  it("does not fetch favicon.ico when the declared favicon is an allowed raster image", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(faviconResponse({
      ok: true,
      status: 200,
      contentType: "image/png",
      body: [1, 2, 3],
    })) as unknown as typeof fetch;
    const { service } = createService({ fetchImpl });

    await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com/docs",
        name: "Example Support",
        faviconUrl: "https://cdn.example.com/icon.png",
      },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example.com/icon.png", expect.any(Object));
  });

  it("creates an agent without a logo when neither favicon candidate yields an allowed raster image", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(faviconResponse({
        ok: true,
        status: 200,
        contentType: "image/svg+xml",
        body: [60, 115, 118, 103, 62],
      }))
      .mockResolvedValueOnce(faviconResponse({
        ok: false,
        status: 404,
        contentType: "text/html",
        body: [60, 104, 116, 109, 108, 62],
      })) as unknown as typeof fetch;
    const { agentService, documentStorage, service } = createService({ fetchImpl });

    const result = await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com/docs",
        name: "Example Support",
        faviconUrl: "https://cdn.example.com/icon.svg",
      },
    });

    expect(result).toEqual({ agentId: "agent-1", crawlJobId: "crawl-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(documentStorage.upload).not.toHaveBeenCalled();
    expect(agentService.update).not.toHaveBeenCalled();
  });

  it("applies derived locale, privacy policy, contact email, and favicon logo in one update", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name === "content-type" ? "image/png" : null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }) as unknown as typeof fetch;
    const { agentService, service } = createService({ fetchImpl });

    await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com",
        name: "Example Support",
        faviconUrl: "https://example.com/favicon.ico",
        assistantDefaultLocale: "de",
        privacyPolicyUrl: "https://example.com/privacy",
        contactEmail: "support@example.com",
      },
    });

    expect(agentService.update).toHaveBeenCalledOnce();
    expect(agentService.update).toHaveBeenCalledWith("workspace-1", "agent-1", {
      assistantDefaultLocale: "de",
      branding: {
        hidePoweredBy: false,
        privacyPolicyUrl: "https://example.com/privacy",
      },
      contactRequestDelivery: {
        recipientEmails: ["support@example.com"],
        webhook: null,
      },
      logo: expect.objectContaining({
        bucket: "logos",
        objectPath: "logo-key",
        mimeType: "image/png",
      }),
    });
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

  it("validates every navigation hop before the browser hits the wire", async () => {
    const validations: string[] = [];
    const fetchPageWithScreenshot = vi.fn(async (url: string, options?: {
      validateNavigationUrl?: (url: string) => Promise<void> | void;
    }) => {
      // Simulate the browser receiving the validator and exercising it for
      // the initial URL plus a redirect target. Aborting one would prevent
      // the request from reaching the network.
      if (options?.validateNavigationUrl) {
        await options.validateNavigationUrl(url);
        await options.validateNavigationUrl("http://169.254.169.254/latest/meta-data/");
      }
      return {
        url,
        title: "Example",
        text: "Example helps support teams. ".repeat(20),
        links: [],
        screenshot: null,
        faviconUrl: null,
      };
    });
    const crawler = createCrawler({ fetchPageWithScreenshot });
    const assertPublicWebsiteUrl = vi.fn(async (url: string) => {
      validations.push(url);
      if (url.includes("169.254")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const { service } = createService({ crawlerProvider: crawler, assertPublicWebsiteUrl });

    await expect(
      service.analyzeWebsite({
        url: "https://example.com",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_url", statusCode: 400 });
    expect(validations).toContain("https://example.com/");
    expect(validations.some((u) => u.includes("169.254"))).toBe(true);
  });

  it("propagates HTTP 401 from the crawler fallback as authentication_required", async () => {
    const crawler = createCrawler({
      isBrowserTransportAvailable: vi.fn().mockResolvedValue(false),
      crawlSite: vi.fn().mockResolvedValueOnce([
        {
          url: "https://example.com",
          title: null,
          text: "",
          status: "failed",
          httpStatus: 401,
          error: "401 Unauthorized",
        },
      ]),
    });
    const { service } = createService({ crawlerProvider: crawler });

    await expect(
      service.analyzeWebsite({
        url: "https://example.com",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("propagates authentication_required from Playwright instead of HTTP-fallback", async () => {
    const fetchPageWithScreenshot = vi.fn().mockRejectedValue(
      new Error("Blocked by status code 401"),
    );
    const crawlSite = vi.fn();
    const crawler = createCrawler({ fetchPageWithScreenshot, crawlSite });
    const { service } = createService({ crawlerProvider: crawler });

    await expect(
      service.analyzeWebsite({
        url: "https://example.com",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(crawlSite).not.toHaveBeenCalled();
  });

  it("re-validates the loaded URL when Playwright follows a redirect", async () => {
    const longText = "Example helps support teams resolve customer questions across many channels. ".repeat(20);
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockResolvedValue({
        url: "http://169.254.169.254/latest/meta-data/",
        title: "Metadata",
        text: longText,
        links: [],
        screenshot: null,
        faviconUrl: null,
      }),
    });
    const assertPublicWebsiteUrl = vi.fn(async (url: string) => {
      if (url.includes("169.254")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const { service } = createService({ crawlerProvider: crawler, assertPublicWebsiteUrl });

    await expect(
      service.analyzeWebsite({
        url: "https://example.com",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_url", statusCode: 400 });
    expect(crawler.crawlSite).not.toHaveBeenCalled();
  });

  it("uses the loaded homepage URL as the scope for follow-up crawling", async () => {
    const crawler = createCrawler({
      fetchPageWithScreenshot: vi.fn().mockResolvedValue({
        url: "https://www.example.com",
        title: "Example",
        text: "Example builds useful support software for complex customer workflows.",
        links: [
          "https://www.example.com/product",
          "https://www.example.com/contact",
          "https://www.example.com/docs",
        ],
        screenshot: null,
        faviconUrl: null,
      }),
    });
    const { service } = createService({ crawlerProvider: crawler });

    await service.analyzeWebsite({
      url: "https://example.com",
      workspaceId: "workspace-1",
    });

    expect(crawler.crawlSite).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://www.example.com",
      }),
    );
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

  it("drops the favicon when its redirect chain ends at a private host", async () => {
    const assertPublicWebsiteUrl = vi.fn(async (url: string) => {
      if (url.includes("169.254")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    // First hop returns a 301 to a private host. The validator must reject
    // the redirect target before the second fetch is issued.
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 301,
      headers: { get: (name: string) => name === "location" ? "http://169.254.169.254/logo.png" : null },
      arrayBuffer: async () => new Uint8Array().buffer,
    }) as unknown as typeof fetch;
    const documentStorage = { upload: vi.fn().mockResolvedValue({ bucket: "logos", objectPath: "k", sizeBytes: 128 }) };
    const agentService = {
      create: vi.fn().mockResolvedValue({ id: "agent-1", name: "Example" }),
      update: vi.fn(),
    };

    const service = new AgentWizardService({
      textGenerationClient: { complete: vi.fn() },
      agentService,
      documentStorage,
      websiteCrawlJobService: { enqueue: vi.fn().mockResolvedValue({ jobId: "j", sourceId: null }) },
      crawlerProvider: createCrawler(),
      assertPublicWebsiteUrl,
      crawlerLimits: { defaultLimit: 100, maxLimit: 1000 },
      auditService: { record: vi.fn().mockResolvedValue(undefined) },
      fetchImpl,
    });

    await service.createAgentFromWizard({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: {
        websiteUrl: "https://example.com",
        name: "Example",
        faviconUrl: "https://example.com/favicon.ico",
      },
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(documentStorage.upload).not.toHaveBeenCalled();
    expect(agentService.update).not.toHaveBeenCalled();
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
