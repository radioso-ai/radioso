import { describe, expect, it } from "vitest";

import {
  anonymousChatSchema,
  publicChatSessionSchema,
} from "../../src/app/http/routes/publicChatRouteSchemas.js";

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
});
