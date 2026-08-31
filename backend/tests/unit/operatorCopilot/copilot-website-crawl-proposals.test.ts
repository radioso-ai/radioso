import { describe, expect, it, vi } from "vitest";
import { normalizeBaseUrl } from "../../../src/modules/websiteCrawler/public.js";

import { createWebsiteCrawlCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/websiteCrawlProposalAdapter.js";
import { createWebsiteCrawlProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/websiteCrawlProposals.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "documents" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const crawlPorts = () => ({
  enqueue: vi.fn(async () => ({ jobId: "job-1", sourceId: "source-1", requestedUrl: "https://help.example.com", status: "queued" as const })),
  assertCrawlUrlAllowed: vi.fn(async () => undefined),
  normalizeCrawlUrl: normalizeBaseUrl,
});

const adapterFor = (crawl = crawlPorts(), policy = { enabled: true, defaultLimit: 50, maxLimit: 200 }) => ({
  adapter: createWebsiteCrawlCopilotProposalAdapter({
    websiteCrawl: crawl,
    workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
    crawlPolicy: () => policy,
  }),
  crawl,
});

const toolFor = (adapter: ReturnType<typeof createWebsiteCrawlCopilotProposalAdapter>) => {
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...input,
  }) as never);
  const record = vi.fn(async () => undefined);
  const [descriptor] = createWebsiteCrawlProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record },
  });
  if (!descriptor) throw new Error("No website crawl proposal descriptor");
  return { descriptor, createProposal, record };
};

describe("start_crawl", () => {
  it("drafts a crawl for review rather than starting one", async () => {
    const { adapter, crawl } = adapterFor();
    const { descriptor, createProposal, record } = toolFor(adapter);

    const result = await descriptor.createTool(context).invoke({
      url: "https://help.example.com",
      limit: 25,
      rationale: "The help centre is not in the knowledge base at all.",
    }, {} as never) as { targetLabel: string; summary: string };

    expect(crawl.enqueue).not.toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "website_crawl",
      targetRef: { url: "https://help.example.com" },
      payload: expect.objectContaining({ url: "https://help.example.com", limit: 25 }),
    }));
    expect(result.targetLabel).toBe("https://help.example.com");
    expect(result.summary).toContain("25");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.created" }));
  });

  it("refuses a url the crawler will not fetch, at draft time rather than on apply", async () => {
    const crawl = crawlPorts();
    crawl.assertCrawlUrlAllowed.mockRejectedValueOnce(new Error("Refusing to crawl a private address"));
    const { adapter } = adapterFor(crawl);
    const { descriptor, createProposal } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ url: "https://localhost" }, {} as never))
      .rejects.toThrow("Refusing to crawl a private address");
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("holds a proposed page count to the deployment's ceiling", async () => {
    const { adapter } = adapterFor(crawlPorts(), { enabled: true, defaultLimit: 50, maxLimit: 100 });
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({ url: "https://help.example.com", limit: 5_000 }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ limit: 100 }),
    }));
  });

  it("falls back to the deployment's default page count", async () => {
    const { adapter } = adapterFor(crawlPorts(), { enabled: true, defaultLimit: 40, maxLimit: 100 });
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({ url: "https://help.example.com" }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ limit: 40 }),
    }));
  });
});

  it("stores a payload its own adapter can read back, however many patterns narrow the crawl", async () => {
    // The card's sentence is part of the payload, so a summary that outgrew the stored schema would
    // persist a proposal whose preview and Apply both fail their strict parse - a card that can only
    // ever fail. The tool parses what it is about to store with the schema the adapter reads it with.
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({
      url: "https://help.example.com",
      includeUrlPatterns: Array.from({ length: 40 }, (_, index) => `/${String(index).padStart(3, "0")}${"x".repeat(190)}`),
      rationale: "y".repeat(1_000),
    }, {} as never);

    const persisted = (createProposal.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    await expect(adapter.preview("workspace-1", { url: "https://help.example.com" }, persisted)).resolves.toBeDefined();
  });

  it("lists a handful of short patterns in full", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    const result = await descriptor.createTool(context).invoke({
      url: "https://help.example.com",
      includeUrlPatterns: ["/docs/*", "/guides/*", "/faq/*"],
    }, {} as never) as { summary: string };

    expect(result.summary).toContain("/docs/*, /guides/*, /faq/*");
    expect(result.summary).not.toContain("more patterns");
  });

  it("names the patterns that fit and counts the rest, so the sentence stays a sentence", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    const result = await descriptor.createTool(context).invoke({
      url: "https://help.example.com",
      includeUrlPatterns: Array.from({ length: 20 }, (_, index) => `/${String(index).padStart(3, "0")}${"x".repeat(190)}`),
    }, {} as never) as { summary: string };

    expect(result.summary).toContain("/000");
    expect(result.summary).toMatch(/\d+ more patterns/);
    expect(result.summary.length).toBeLessThan(2_000);
  });

  it("refuses a url carrying credentials while drafting, rather than storing and showing them", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ url: "https://user:secret@help.example.com" }, {} as never))
      .rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("drafts the url the crawl will actually use, not the one as typed", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    const result = await descriptor.createTool(context).invoke({ url: "https://help.example.com/docs/#section" }, {} as never) as { targetLabel: string };

    expect(result.targetLabel).toBe("https://help.example.com/docs");
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetRef: { url: "https://help.example.com/docs" },
    }));
  });

describe("website crawl proposal adapter", () => {
  // A crawl job carries no identity a second attempt could recognise as its own, so a retry after
  // an interrupted apply would re-fetch the site rather than notice the first one already ran.
  it("declares that an interrupted apply must not be retried", () => {
    const { adapter } = adapterFor();

    expect(adapter.canRetryAfterInterruptedApply?.({ url: "https://help.example.com" }, { name: "https://help.example.com", url: "https://help.example.com", limit: 25, includeUrlPatterns: [], excludeUrlPatterns: [], preserveContentLinks: true })).toBe(false);
  });

  it("enqueues the crawl with the workspace's account when applied", async () => {
    const { adapter, crawl } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { url: "https://help.example.com" }, {
      name: "https://help.example.com",
      url: "https://help.example.com",
      limit: 25,
      includeUrlPatterns: ["/docs/*"],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    }, "crawl");

    expect(crawl.enqueue).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      url: "https://help.example.com",
      limit: 25,
      policy: { includeUrlPatterns: ["/docs/*"], excludeUrlPatterns: [], preserveContentLinks: true },
    });
    expect(outcome).toEqual({ outcome: "applied", appliedRef: { jobId: "job-1", sourceId: "source-1" } });
  });

  it("reports the crawler refusing the url as a failure, not a silent success", async () => {
    const crawl = crawlPorts();
    crawl.enqueue.mockRejectedValueOnce(new Error("Website crawling is unavailable"));
    const { adapter } = adapterFor(crawl);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { url: "https://help.example.com" }, {
      name: "https://help.example.com",
      url: "https://help.example.com",
      limit: 25,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    }, "crawl");

    expect(outcome).toEqual({ outcome: "failed", reason: "Website crawling is unavailable" });
  });

  it("refuses to draft a crawl on a deployment with crawling turned off", async () => {
    const { adapter } = adapterFor(crawlPorts(), { enabled: false, defaultLimit: 50, maxLimit: 200 });
    const { descriptor, createProposal } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ url: "https://help.example.com" }, {} as never))
      .rejects.toThrow(/disabled/i);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("holds an applied crawl to the ceiling in force now, not the one captured at draft", async () => {
    const crawl = crawlPorts();
    const { adapter } = adapterFor(crawl, { enabled: true, defaultLimit: 50, maxLimit: 60 });

    await adapter.applyIfVersionMatches("workspace-1", { url: "https://help.example.com" }, {
      name: "https://help.example.com",
      url: "https://help.example.com",
      limit: 1_000,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    }, "crawl");

    expect(crawl.enqueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 60 }));
  });

  it("refuses to apply a crawl after the deployment turned crawling off", async () => {
    const crawl = crawlPorts();
    const { adapter } = adapterFor(crawl, { enabled: false, defaultLimit: 50, maxLimit: 200 });

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { url: "https://help.example.com" }, {
      name: "https://help.example.com",
      url: "https://help.example.com",
      limit: 25,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    }, "crawl");

    expect(outcome).toMatchObject({ outcome: "failed" });
    expect(crawl.enqueue).not.toHaveBeenCalled();
  });

  it("previews the crawl as an addition, with no current state to compare against", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", { url: "https://help.example.com" }, {
      name: "https://help.example.com",
      url: "https://help.example.com",
      limit: 25,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    });

    expect(preview).toMatchObject({
      targetLabel: "https://help.example.com",
      current: null,
      proposed: { url: "https://help.example.com", limit: 25 },
    });
  });
});
