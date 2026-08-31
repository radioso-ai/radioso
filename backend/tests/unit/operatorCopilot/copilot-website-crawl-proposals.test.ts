import { describe, expect, it, vi } from "vitest";

import { createWebsiteCrawlCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/websiteCrawlProposalAdapter.js";
import { createWebsiteCrawlProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/websiteCrawlProposals.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "documents" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const crawlPorts = () => ({
  enqueue: vi.fn(async () => ({ jobId: "job-1", sourceId: "source-1", requestedUrl: "https://help.example.com", status: "queued" as const })),
  assertCrawlUrlAllowed: vi.fn(async () => undefined),
});

const adapterFor = (crawl = crawlPorts(), limits = { defaultLimit: 50, maxLimit: 200 }) => ({
  adapter: createWebsiteCrawlCopilotProposalAdapter({
    websiteCrawl: crawl,
    workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
    crawlLimits: limits,
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
    const { adapter } = adapterFor(crawlPorts(), { defaultLimit: 50, maxLimit: 100 });
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({ url: "https://help.example.com", limit: 5_000 }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ limit: 100 }),
    }));
  });

  it("falls back to the deployment's default page count", async () => {
    const { adapter } = adapterFor(crawlPorts(), { defaultLimit: 40, maxLimit: 100 });
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({ url: "https://help.example.com" }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ limit: 40 }),
    }));
  });
});

describe("website crawl proposal adapter", () => {
  it("enqueues the crawl with the workspace's account when applied", async () => {
    const { adapter, crawl } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { url: "https://help.example.com" }, {
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
      url: "https://help.example.com",
      limit: 25,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    }, "crawl");

    expect(outcome).toEqual({ outcome: "failed", reason: "Website crawling is unavailable" });
  });

  it("previews the crawl as an addition, with no current state to compare against", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", { url: "https://help.example.com" }, {
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
