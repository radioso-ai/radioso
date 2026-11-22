/**
 * The largest share of a source's pages a crawl removes on its own. A site that loses more than
 * this between two crawls is more likely broken, moved, or blocking the crawler than pruned, so
 * the pages wait for the operator.
 */
export const MISSING_PAGE_HOLD_SHARE = 0.2;

type MissingPageRemoval = "remove" | "hold";

/**
 * What a complete crawl does with the source's pages it no longer found, whatever started it: it
 * removes them while they are a small share of the pages the source had before it ran, and holds
 * them for the operator otherwise.
 */
export const decideMissingPageRemoval = (input: {
  missingPageCount: number;
  livePageCountBeforeCrawl: number;
}): MissingPageRemoval =>
  input.missingPageCount <= MISSING_PAGE_HOLD_SHARE * input.livePageCountBeforeCrawl ? "remove" : "hold";
