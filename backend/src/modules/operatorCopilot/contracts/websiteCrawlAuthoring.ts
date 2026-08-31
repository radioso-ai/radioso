import { z } from "zod";

import type { CopilotWorkspaceAccountResolver } from "./documentAuthoring.js";

const crawlPatternSchema = z.array(z.string().trim().min(1).max(200)).max(50);

const httpUrlSchema = z.string().trim().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use http or https");

/** What a tool asks for. The page count is optional here and settled against the deployment's own
 * ceiling during validation, so a proposal can never promise a crawl larger than the deployment
 * would run. */
export const copilotWebsiteCrawlChangeSchema = z.object({
  url: httpUrlSchema,
  limit: z.number().int().positive().optional(),
  includeUrlPatterns: crawlPatternSchema.optional(),
  excludeUrlPatterns: crawlPatternSchema.optional(),
  preserveContentLinks: z.boolean().optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

export const copilotWebsiteCrawlPayloadSchema = z.object({
  /** Every proposal card reads its target's label from `name`; a crawl is named by its URL. */
  name: httpUrlSchema,
  url: httpUrlSchema,
  limit: z.number().int().positive(),
  includeUrlPatterns: crawlPatternSchema,
  excludeUrlPatterns: crawlPatternSchema,
  preserveContentLinks: z.boolean(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

export const copilotWebsiteCrawlTargetRefSchema = z.object({ url: httpUrlSchema }).strict();

export type CopilotWebsiteCrawlChange = z.infer<typeof copilotWebsiteCrawlChangeSchema>;
export type CopilotWebsiteCrawlPayload = z.infer<typeof copilotWebsiteCrawlPayloadSchema>;

export interface CopilotWebsiteCrawlPort {
  /** The same guard the crawler applies before fetching, so a card is never drafted for a URL the
   * crawl would refuse. */
  assertCrawlUrlAllowed(url: string): Promise<void>;
  enqueue(input: {
    accountId?: string | null;
    workspaceId: string;
    url: string;
    limit: number;
    policy: {
      includeUrlPatterns: string[];
      excludeUrlPatterns: string[];
      preserveContentLinks: boolean;
    };
  }): Promise<{ jobId: string; sourceId: string | null }>;
}

/**
 * The deployment's own crawl policy, read at draft AND at apply. A deployment can turn crawling off
 * or lower its ceiling between the two, and a card that was runnable when drafted must not run
 * outside the policy in force when it is applied.
 */
export interface CopilotWebsiteCrawlPolicy {
  readonly enabled: boolean;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

export type { CopilotWorkspaceAccountResolver };
