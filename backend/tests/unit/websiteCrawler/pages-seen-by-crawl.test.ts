import { describe, expect, it } from "vitest";

import { pagesSeenByCrawl } from "../../../src/modules/websiteCrawler/missingPages.js";
import {
  buildWebsiteExternalDocumentId,
  normalizePageUrl,
  redactWebsiteCrawlerUrl,
} from "../../../src/modules/websiteCrawler/pageUrls.js";

const websiteBaseUrl = "https://docs.example";
// The id ingestion publishes a page under: its canonical URL normalized, redacted, then built.
const publishedId = (canonicalUrl: string) =>
  buildWebsiteExternalDocumentId({ websiteBaseUrl, pageUrl: redactWebsiteCrawlerUrl(normalizePageUrl(canonicalUrl)) });

describe("the pages a crawl saw", () => {
  it("maps each processed canonical URL to the id ingestion published that page under", () => {
    const processed = [
      "https://docs.example/a",
      "https://docs.example/b/",
      "https://docs.example/c?token=abc&x=1",
      "https://docs.example/d#part",
      "https://docs.example/e?q=a%20b&api_key=secret",
    ];

    const seen = pagesSeenByCrawl({ websiteBaseUrl, processedCanonicalUrls: processed, publishedExternalDocumentIds: [] });

    expect(seen).toEqual(processed.map(publishedId));
    expect(seen).toContain("website:https://docs.example:https://docs.example/c?token=%5Bredacted%5D&x=1");
    expect(seen).toContain("website:https://docs.example:https://docs.example/b");
  });

  it("keeps the ids the crawl published, lists each once, and skips addresses it cannot read", () => {
    const seen = pagesSeenByCrawl({
      websiteBaseUrl,
      processedCanonicalUrls: ["https://docs.example/a", "not a url", "https://docs.example/a/"],
      publishedExternalDocumentIds: [publishedId("https://docs.example/a"), "website:https://docs.example:https://docs.example/z"],
    });

    expect(seen).toEqual([publishedId("https://docs.example/a"), "website:https://docs.example:https://docs.example/z"]);
  });
});
