import {
  copilotWebsiteCrawlChangeSchema,
  copilotWebsiteCrawlPayloadSchema,
  type CopilotWebsiteCrawlPayload,
} from "../contracts/websiteCrawlAuthoring.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  boundedSummary,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const MANAGE_DOCUMENTS = ["workspace.documents.manage"] as const;
const NAME = "start_crawl";
const DESCRIPTION = "Propose crawling a website into the workspace knowledge base, for the operator to review and start. Drafting costs nothing; applying fetches the site and indexes what it finds, so say which pages matter and why the site is worth crawling. To refresh a site that is already a source, use recrawl_source instead.";

export type WebsiteCrawlProposalCopilotToolDependencies = CopilotProposalToolDependencies;

/**
 * How much of the card's sentence the pattern list may take. Patterns are individually long and
 * there can be fifty of them, so the list is bounded by characters rather than by count: the stored
 * payload has its own ceiling, and a sentence that outgrew it would persist a card whose preview and
 * Apply could only ever fail.
 */
const SCOPE_BUDGET = 600;

const describeScope = (patterns: ReadonlyArray<string>): string => {
  if (patterns.length === 0) return "";
  const listed: string[] = [];
  let used = 0;
  for (const pattern of patterns) {
    if (used + pattern.length > SCOPE_BUDGET) break;
    listed.push(pattern);
    used += pattern.length + 2;
  }
  const rest = patterns.length - listed.length;
  if (listed.length === 0) return ` matching ${patterns.length} URL patterns`;
  return rest > 0 ? ` matching ${listed.join(", ")} and ${rest} more patterns` : ` matching ${listed.join(", ")}`;
};

const summarize = (payload: CopilotWebsiteCrawlPayload): string => {
  const summary = `Crawl ${payload.url}, up to ${payload.limit} pages${describeScope(payload.includeUrlPatterns)}.`;
  return payload.rationale ? `${summary} ${payload.rationale}` : summary;
};

export const createWebsiteCrawlProposalCopilotTools = (
  deps: WebsiteCrawlProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "website_crawl");
  const shared = {
    name: NAME,
    description: DESCRIPTION,
    inputSchema: copilotWebsiteCrawlChangeSchema,
    outputSchema: proposalOutputSchema,
  };
  return [{
    ...shared,
    shape: "propose",
    uiLabel: "Drafting a website crawl",
    contributingModule: "websiteCrawler",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_DOCUMENTS] as unknown as CopilotToolDescriptor["requiredPermissions"],
    createTool: (context) => ({
      ...shared,
      invoke: async (rawChange) => {
        const change = copilotWebsiteCrawlChangeSchema.parse(rawChange);
        await requireCurrentCopilotPermissions(context, [...MANAGE_DOCUMENTS]);
        // validatePayload settles the page count against the deployment's ceiling and refuses a URL
        // the crawler would not fetch, so both are decided before an operator sees a card.
        const validated = await adapter.validatePayload(context.workspaceId, { url: change.url }, change);
        const payload = validated.payload as CopilotWebsiteCrawlPayload;
        await requireCurrentCopilotPermissions(context, [...MANAGE_DOCUMENTS]);
        const summary = boundedSummary(summarize(payload));
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          conversationId: requiredCopilotConversation(context),
          targetType: "website_crawl",
          targetRef: validated.targetRef,
          payload: copilotWebsiteCrawlPayloadSchema.parse({ ...payload, summary }),
          versionToken: validated.versionToken,
          // A crawl installs through no agent config override, so no replay measures it.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: "website_crawl" as const,
          targetLabel: payload.url,
          summary,
        };
      },
    }),
  } as CopilotToolDescriptor];
};
