import {
  copilotWebsiteCrawlChangeSchema,
  copilotWebsiteCrawlPayloadSchema,
  copilotWebsiteCrawlTargetRefSchema,
  type CopilotWebsiteCrawlLimits,
  type CopilotWebsiteCrawlPort,
  type CopilotWorkspaceAccountResolver,
} from "./contracts/websiteCrawlAuthoring.js";
import type { CopilotWebsiteCrawlProposalAdapter } from "./contracts.js";

/**
 * A crawl proposal addresses no stored row: applying it starts a job rather than changing a
 * setting, so there is no version for it to be stale against. What the card actually guards is that
 * an operator, not Ray, decides to spend a crawl on a site.
 */
const CRAWL_VERSION_TOKEN = "crawl";

export interface WebsiteCrawlCopilotProposalAdapterDependencies {
  readonly websiteCrawl: CopilotWebsiteCrawlPort;
  readonly workspaceAccount: CopilotWorkspaceAccountResolver;
  readonly crawlLimits: CopilotWebsiteCrawlLimits;
}

export const createWebsiteCrawlCopilotProposalAdapter = (
  deps: WebsiteCrawlCopilotProposalAdapterDependencies,
): CopilotWebsiteCrawlProposalAdapter => ({
  targetType: "website_crawl",

  async readVersionToken(_workspaceId, rawTargetRef) {
    copilotWebsiteCrawlTargetRefSchema.parse(rawTargetRef);
    return CRAWL_VERSION_TOKEN;
  },

  async preview(_workspaceId, rawTargetRef, rawPayload) {
    copilotWebsiteCrawlTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWebsiteCrawlPayloadSchema.parse(rawPayload);
    return { targetLabel: payload.url, current: null, proposed: payload };
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload) {
    copilotWebsiteCrawlTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWebsiteCrawlPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.websiteCrawl.enqueue({
        accountId: await deps.workspaceAccount.resolveAccountId(workspaceId),
        workspaceId,
        url: payload.url,
        limit: payload.limit,
        policy: {
          includeUrlPatterns: payload.includeUrlPatterns,
          excludeUrlPatterns: payload.excludeUrlPatterns,
          preserveContentLinks: payload.preserveContentLinks,
        },
      });
      return { outcome: "applied" as const, appliedRef: { jobId: result.jobId, sourceId: result.sourceId } };
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Crawl could not be started" };
    }
  },

  async validatePayload(_workspaceId, rawTargetRef, rawChange) {
    copilotWebsiteCrawlTargetRefSchema.parse(rawTargetRef);
    const change = copilotWebsiteCrawlChangeSchema.parse(rawChange);
    // Checked here so a URL the crawler would refuse fails while Ray is drafting, rather than
    // reaching an operator as a card that can only fail when they choose Apply.
    await deps.websiteCrawl.assertCrawlUrlAllowed(change.url);
    return {
      targetRef: { url: change.url },
      payload: copilotWebsiteCrawlPayloadSchema.parse({
        url: change.url,
        limit: Math.min(change.limit ?? deps.crawlLimits.defaultLimit, deps.crawlLimits.maxLimit),
        includeUrlPatterns: change.includeUrlPatterns ?? [],
        excludeUrlPatterns: change.excludeUrlPatterns ?? [],
        preserveContentLinks: change.preserveContentLinks ?? true,
        ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
      }),
      versionToken: CRAWL_VERSION_TOKEN,
    };
  },
});
