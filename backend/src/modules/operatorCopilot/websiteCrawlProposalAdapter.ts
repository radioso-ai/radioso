import {
  copilotWebsiteCrawlChangeSchema,
  copilotWebsiteCrawlPayloadSchema,
  copilotWebsiteCrawlTargetRefSchema,
  type CopilotWebsiteCrawlPolicy,
  type CopilotWebsiteCrawlPort,
  type CopilotWorkspaceAccountResolver,
} from "./contracts/websiteCrawlAuthoring.js";
import type { CopilotWebsiteCrawlProposalAdapter } from "./contracts.js";
import { badRequest } from "../../shared/domain/errors.js";

/**
 * A crawl proposal addresses no stored row: applying it starts a job rather than changing a
 * setting, so there is no version for it to be stale against. What the card actually guards is that
 * an operator, not Ray, decides to spend a crawl on a site.
 */
const CRAWL_VERSION_TOKEN = "crawl";

export interface WebsiteCrawlCopilotProposalAdapterDependencies {
  readonly websiteCrawl: CopilotWebsiteCrawlPort;
  readonly workspaceAccount: CopilotWorkspaceAccountResolver;
  readonly crawlPolicy: () => CopilotWebsiteCrawlPolicy;
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
    const { name: _name, rationale: _rationale, summary: _summary, ...crawl } = payload;
    return { targetLabel: payload.url, current: null, proposed: crawl };
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload) {
    copilotWebsiteCrawlTargetRefSchema.parse(rawTargetRef);
    const payload = copilotWebsiteCrawlPayloadSchema.parse(rawPayload);
    try {
      // Read again rather than trusting the draft: a deployment that turned crawling off, or
      // lowered its ceiling, since the card was written governs what actually runs.
      const policy = deps.crawlPolicy();
      if (!policy.enabled) return { outcome: "failed" as const, reason: "Website crawling is disabled for this deployment." };
      const result = await deps.websiteCrawl.enqueue({
        accountId: await deps.workspaceAccount.resolveAccountId(workspaceId),
        workspaceId,
        url: payload.url,
        limit: Math.min(payload.limit, policy.maxLimit),
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
    const policy = deps.crawlPolicy();
    // A deployment with crawling off removes the crawl route and its workers exit, so a card drafted
    // here could only ever queue a job nothing would run.
    if (!policy.enabled) throw badRequest("Website crawling is disabled for this deployment.");
    // Both checks run here so a URL the crawler would refuse fails while Ray is drafting, rather
    // than reaching an operator as a card that can only fail when they choose Apply. Normalizing
    // also settles what the card shows to the URL the crawl will actually use.
    const url = deps.websiteCrawl.normalizeCrawlUrl(change.url);
    await deps.websiteCrawl.assertCrawlUrlAllowed(url);
    return {
      targetRef: { url },
      payload: copilotWebsiteCrawlPayloadSchema.parse({
        name: url,
        url,
        limit: Math.min(change.limit ?? policy.defaultLimit, policy.maxLimit),
        includeUrlPatterns: change.includeUrlPatterns ?? [],
        excludeUrlPatterns: change.excludeUrlPatterns ?? [],
        preserveContentLinks: change.preserveContentLinks ?? true,
        ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
      }),
      versionToken: CRAWL_VERSION_TOKEN,
    };
  },
});
