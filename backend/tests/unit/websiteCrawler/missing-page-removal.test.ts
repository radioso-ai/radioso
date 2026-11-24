import { describe, expect, it } from "vitest";

import {
  MISSING_PAGE_HOLD_SHARE,
  decideMissingPageRemoval,
} from "../../../src/modules/websiteCrawler/missingPageRemoval.js";

describe("what a crawl does with pages it no longer finds", () => {
  it("removes them when they are a fifth of the source or less", () => {
    expect(MISSING_PAGE_HOLD_SHARE).toBe(0.2);
    expect(decideMissingPageRemoval({ missingPageCount: 0, livePageCountBeforeCrawl: 10 })).toBe("remove");
    expect(decideMissingPageRemoval({ missingPageCount: 2, livePageCountBeforeCrawl: 10 })).toBe("remove");
    expect(decideMissingPageRemoval({ missingPageCount: 20, livePageCountBeforeCrawl: 100 })).toBe("remove");
  });

  it("holds them for review when they are more than a fifth of the source", () => {
    expect(decideMissingPageRemoval({ missingPageCount: 3, livePageCountBeforeCrawl: 10 })).toBe("hold");
    expect(decideMissingPageRemoval({ missingPageCount: 21, livePageCountBeforeCrawl: 100 })).toBe("hold");
    expect(decideMissingPageRemoval({ missingPageCount: 1, livePageCountBeforeCrawl: 1 })).toBe("hold");
  });

  it("holds them when the source's earlier page count is unknown or smaller than what went missing", () => {
    expect(decideMissingPageRemoval({ missingPageCount: 1, livePageCountBeforeCrawl: 0 })).toBe("hold");
  });
});
