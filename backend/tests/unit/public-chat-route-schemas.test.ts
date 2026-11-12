import { describe, expect, it } from "vitest";

import {
  anonymousChatSchema,
  pageContextSchema,
  publicChatSessionSchema,
} from "../../src/app/http/routes/publicChatRouteSchemas.js";
import { replyBlocksCapabilityFromRequest } from "../../src/modules/chat/contracts/replyBlocks.js";

const clientContextCapabilities = {
  "page.read": {
    available: true,
    mode: "content" as const,
    supportedOperations: ["metadata", "lookup", "summarize"] as const,
  },
};

describe("public chat route schemas", () => {
  it("accepts chat and session requests with or without client context capabilities", () => {
    expect(anonymousChatSchema.safeParse({ message: "Hello", stream: false }).success).toBe(true);
    expect(publicChatSessionSchema.safeParse({ channel: "website_embed" }).success).toBe(true);

    expect(anonymousChatSchema.parse({
      message: "Summarize this page",
      stream: false,
      clientContextCapabilities,
    }).clientContextCapabilities).toEqual(clientContextCapabilities);
    expect(publicChatSessionSchema.parse({
      channel: "website_embed",
      clientContextCapabilities,
    }).clientContextCapabilities).toEqual(clientContextCapabilities);
  });

  it.each([
    { available: "yes", mode: "content", supportedOperations: ["metadata"] },
    { available: true, mode: "full", supportedOperations: ["metadata"] },
    { available: true, mode: "content", supportedOperations: ["metadata", "lookup", "summarize", "metadata"] },
    { available: true, mode: "content", supportedOperations: ["transform"] },
  ])("rejects malformed page-read capability %#", (pageRead) => {
    const request = {
      message: "Hello",
      stream: false,
      clientContextCapabilities: { "page.read": pageRead },
    };

    expect(anonymousChatSchema.safeParse(request).success).toBe(false);
    expect(publicChatSessionSchema.safeParse({
      channel: "website_embed",
      clientContextCapabilities: request.clientContextCapabilities,
    }).success).toBe(false);
  });

  describe("pageContext.referrer (FR-013)", () => {
    it("keeps a valid http(s) referrer", () => {
      expect(pageContextSchema.parse({ referrer: "https://example.com/pricing" })).toMatchObject({
        referrer: "https://example.com/pricing",
      });
      expect(pageContextSchema.parse({ referrer: "http://example.com" })).toMatchObject({
        referrer: "http://example.com",
      });
    });

    it("strips a referrer that is not an http(s) URL", () => {
      expect(pageContextSchema.parse({ referrer: "javascript:alert(1)" })).toMatchObject({ referrer: null });
      expect(pageContextSchema.parse({ referrer: "/relative/path" })).toMatchObject({ referrer: null });
      expect(pageContextSchema.parse({ referrer: "not a url" })).toMatchObject({ referrer: null });
    });

    it("normalizes an absent referrer to null", () => {
      expect(pageContextSchema.parse({})).toMatchObject({ referrer: null });
    });

    it("caps a referrer at 2048 characters before validating it as a URL", () => {
      const longPath = "a".repeat(3000);
      const parsed = pageContextSchema.parse({ referrer: `https://example.com/${longPath}` });
      expect(parsed?.referrer?.length).toBe(2048);
    });
  });
});

describe("public chat reply blocks capability", () => {
  it("accepts the reply blocks a client renders, keeping the layouts as declared", () => {
    const parsed = anonymousChatSchema.parse({
      message: "Hiking guides?",
      clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel", "grid", "table"] } } },
    });

    expect(parsed.clientContextCapabilities?.["reply.blocks"]).toEqual({ item_list: { layouts: ["carousel", "grid", "table"] } });
    expect(replyBlocksCapabilityFromRequest(parsed.clientContextCapabilities?.["reply.blocks"])).toEqual({
      item_list: { layouts: ["carousel", "grid"] },
    });
  });

  it("drops a block kind the server does not know", () => {
    const parsed = anonymousChatSchema.parse({
      message: "Hiking guides?",
      clientContextCapabilities: { "reply.blocks": { choices: { max: 3 } } },
    });

    expect(parsed.clientContextCapabilities?.["reply.blocks"]).toEqual({});
    expect(replyBlocksCapabilityFromRequest(parsed.clientContextCapabilities?.["reply.blocks"])).toBeNull();
  });

  it("refuses an oversized declaration", () => {
    expect(anonymousChatSchema.safeParse({
      message: "Hiking guides?",
      clientContextCapabilities: { "reply.blocks": { item_list: { layouts: Array.from({ length: 40 }, () => "grid") } } },
    }).success).toBe(false);
  });
});
