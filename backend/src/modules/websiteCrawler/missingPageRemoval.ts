import type { CrawlTrigger } from "./recrawlSchedule.js";

/**
 * The largest share of a source's pages a scheduled crawl removes on its own. A site that loses
 * more than this between two scheduled crawls is more likely broken, moved, or blocking the
 * crawler than pruned, so the pages wait for the operator.
 */
export const MISSING_PAGE_HOLD_SHARE = 0.2;

type MissingPageRemoval = "remove" | "hold";

/**
 * What a complete crawl does with the source's pages it no longer found. A crawl the operator
 * started removes them, as they asked for a fresh copy of the site. A scheduled crawl removes them
 * only while they are a small share of the pages the source had before it ran.
 */
export const decideMissingPageRemoval = (input: {
  trigger: CrawlTrigger;
  missingPageCount: number;
  livePageCountBeforeCrawl: number;
}): MissingPageRemoval => {
  if (input.trigger === "manual" || input.missingPageCount === 0) {
    return "remove";
  }
  return input.missingPageCount <= MISSING_PAGE_HOLD_SHARE * input.livePageCountBeforeCrawl ? "remove" : "hold";
};
