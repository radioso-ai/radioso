import { describe, expect, it } from "vitest";

import {
  isProductAnalyticsEventName,
  productAnalyticsEventNames,
} from "../../src/shared/analytics/productAnalyticsTypes.js";

describe("product analytics taxonomy", () => {
  it("defines the approved baseline event names", () => {
    expect(productAnalyticsEventNames).toContain("workspace.created");
    expect(productAnalyticsEventNames).toContain("document.processing_completed");
    expect(productAnalyticsEventNames).toContain("chat.completed");
    expect(productAnalyticsEventNames).toContain("chat.citation_clicked");
    expect(productAnalyticsEventNames).toContain("retrieval_settings.updated");
    expect(productAnalyticsEventNames).toContain("website_embed.loaded");
  });

  it("recognizes known event names and rejects unknown ones", () => {
    expect(isProductAnalyticsEventName("chat.completed")).toBe(true);
    expect(isProductAnalyticsEventName("unknown.event")).toBe(false);
  });
});
