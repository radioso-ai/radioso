export type CrawlCandidateDecisionOutcome = "accepted" | "rejected";

export type CrawlCandidateDecisionReason =
  | "accepted"
  | "duplicate"
  | "invalid_url"
  | "junk"
  | "out_of_scope"
  | "policy_asset"
  | "policy_defer"
  | "policy_deny"
  | "page_limit_reached";

export type CrawlCandidateDecision = {
  url: string;
  canonicalUrl: string | null;
  decision: CrawlCandidateDecisionOutcome;
  reason: CrawlCandidateDecisionReason;
  matchedRuleId?: string | null;
  matchedScope?: "site" | "global" | null;
};

export const buildAcceptedCandidateDecision = (
  url: string,
  canonicalUrl: string,
  metadata?: {
    matchedRuleId?: string | null;
    matchedScope?: "site" | "global" | null;
  }
): CrawlCandidateDecision => ({
  url,
  canonicalUrl,
  decision: "accepted",
  reason: "accepted",
  matchedRuleId: metadata?.matchedRuleId ?? null,
  matchedScope: metadata?.matchedScope ?? null
});

export const buildRejectedCandidateDecision = (
  url: string,
  reason: Exclude<CrawlCandidateDecisionReason, "accepted">,
  canonicalUrl: string | null = null,
  metadata?: {
    matchedRuleId?: string | null;
    matchedScope?: "site" | "global" | null;
  }
): CrawlCandidateDecision => ({
  url,
  canonicalUrl,
  decision: "rejected",
  reason,
  matchedRuleId: metadata?.matchedRuleId ?? null,
  matchedScope: metadata?.matchedScope ?? null
});
