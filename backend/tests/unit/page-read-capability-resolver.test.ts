import { describe, expect, it } from "vitest";

import { pageReadCapabilityFromRequest } from "../../src/modules/chat/services/pageRead/pageReadCapabilityResolver.js";
import type { PageReadCapability } from "../../src/modules/chat/services/pageRead/pageReadDecision.js";

describe("pageReadCapabilityFromRequest", () => {
  it("does not let an explicit content advertisement exceed the supplied payload", () => {
    const advertised: PageReadCapability = {
      available: true,
      mode: "content",
      supportedOperations: ["metadata", "lookup", "summarize"],
    };

    expect(pageReadCapabilityFromRequest({ "page.read": advertised }, {
      pageUrl: "https://example.com/docs",
    })).toEqual({
      available: true,
      mode: "metadata",
      supportedOperations: ["metadata"],
    });
  });

  it("marks an advertised page read unavailable when no page payload exists", () => {
    const advertised: PageReadCapability = {
      available: true,
      mode: "content",
      supportedOperations: ["metadata", "lookup", "summarize"],
    };

    expect(pageReadCapabilityFromRequest({
      "page.read": advertised,
    }, undefined)).toEqual({
      available: false,
      mode: null,
      supportedOperations: [],
    });
  });

  it("preserves an explicit capability restriction when content exists", () => {
    const advertised: PageReadCapability = {
      available: true,
      mode: "metadata",
      supportedOperations: ["metadata"],
    };

    expect(pageReadCapabilityFromRequest({ "page.read": advertised }, {
      pageUrl: "https://example.com/docs",
      content: "Page content",
    })).toEqual(advertised);
  });

  it("derives content capability from legacy non-empty page content", () => {
    expect(pageReadCapabilityFromRequest(undefined, { content: "Page content" })).toEqual({
      available: true,
      mode: "content",
      supportedOperations: ["metadata", "lookup", "summarize"],
    });
  });

  it("derives metadata-only capability from legacy page context without content", () => {
    expect(pageReadCapabilityFromRequest(undefined, {
      pageUrl: "https://example.com/docs",
      content: "   ",
    })).toEqual({
      available: true,
      mode: "metadata",
      supportedOperations: ["metadata"],
    });
  });

  it("returns null when neither an advertisement nor page context is present", () => {
    expect(pageReadCapabilityFromRequest(undefined, undefined)).toBeNull();
  });
});
