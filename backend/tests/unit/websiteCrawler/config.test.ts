import { describe, expect, it } from "vitest";

import {
  resolveWebsiteCrawlerConfig,
} from "../../../src/modules/websiteCrawler/config.js";

describe("website crawler config", () => {
  it("uses generic crawler limits when no env is configured", () => {
    expect(resolveWebsiteCrawlerConfig({})).toEqual({
      defaultLimit: 10,
      maxLimit: 100,
    });
  });

  it("reads generic crawler limits without selecting a concrete provider", () => {
    const config = resolveWebsiteCrawlerConfig({
      WEBSITE_CRAWLER_DEFAULT_LIMIT: "7",
      WEBSITE_CRAWLER_MAX_LIMIT: "20",
    });

    expect(config).toEqual({
      defaultLimit: 7,
      maxLimit: 20,
    });
  });

  it("rejects invalid numeric limit configuration", () => {
    expect(() => resolveWebsiteCrawlerConfig({
      WEBSITE_CRAWLER_MAX_LIMIT: "nope",
    })).toThrow("WEBSITE_CRAWLER_MAX_LIMIT must be a positive integer");
  });

  it("caps the default limit at the configured max limit", () => {
    expect(resolveWebsiteCrawlerConfig({
      WEBSITE_CRAWLER_DEFAULT_LIMIT: "500",
      WEBSITE_CRAWLER_MAX_LIMIT: "25",
    })).toEqual(expect.objectContaining({
      defaultLimit: 25,
      maxLimit: 25,
    }));
  });
});
