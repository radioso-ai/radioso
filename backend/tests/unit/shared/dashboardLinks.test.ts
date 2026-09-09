import { describe, expect, it } from "vitest";

import { conversationPermalink } from "../../../src/shared/domain/dashboardLinks.js";

describe("conversationPermalink", () => {
  it("addresses a conversation through the workspace activity route", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.origin).toBe("https://app.radioso.ai");
    expect(url.pathname).toBe("/w/support-abc123/activity");
    expect(url.searchParams.get("itemKind")).toBe("chat");
    expect(url.searchParams.get("itemId")).toBe("conv_1");
  });

  it("names the lens explicitly so the runtime default cannot redirect the operator away", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.searchParams.get("tab")).toBe("all");
    expect(url.searchParams.get("filter")).toBe("chat");
  });

  it("falls back to the local development origin when no base URL is configured", () => {
    expect(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      undefined,
    )).toContain("http://localhost:3000/w/support-abc123/activity");
  });

  it("escapes a workspace key so it cannot alter the path", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "a/../../evil", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.pathname).toBe("/w/a%2F..%2F..%2Fevil/activity");
  });
});
