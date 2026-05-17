import { describe, expect, it } from "vitest";

import { renderHumanContactRequestEmail } from "./contactRequestEmailTemplate.js";

const baseInput = {
  to: "support@example.com",
  visitorEmail: "user@example.com",
  message: "Please contact me.",
  workspace: { name: "Acme Workspace", publicRouteKey: "acme" },
  sourceChannel: "website_embed",
  createdAt: new Date("2026-05-04T10:00:00.000Z"),
  requestId: "request-1",
  workspaceId: "workspace-1",
  dashboardUrl: "https://app.example.com/w/acme/activity?filter=contact&itemKind=contact&itemId=request-1",
};

describe("renderHumanContactRequestEmail", () => {
  it("renders subject, reply-to, deep link, and metadata when workspace + dashboard URL are provided", () => {
    const message = renderHumanContactRequestEmail(baseInput);

    expect(message.subject).toBe("[Acme Workspace] New contact request from user@example.com");
    expect(message.replyTo).toBe("user@example.com");
    expect(message.text).toContain("Acme Workspace");
    expect(message.text).toContain("via website embed");
    expect(message.text).toContain("Please contact me.");
    expect(message.text).toContain(baseInput.dashboardUrl);
    expect(message.text).not.toContain("workspace-1");
    expect(message.html).toContain("Please contact me.");
    expect(message.html).toContain(
      "https://app.example.com/w/acme/activity?filter=contact&amp;itemKind=contact&amp;itemId=request-1",
    );
    expect(message.metadata).toEqual({
      kind: "human_contact_request",
      requestId: "request-1",
      workspaceId: "workspace-1",
    });
  });

  it("omits dashboard link and workspace prefix when not provided", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      workspace: null,
      dashboardUrl: null,
      sourceChannel: null,
    });

    expect(message.subject).toBe("New contact request from user@example.com");
    expect(message.text).not.toContain("Open in Radioso");
    expect(message.html).not.toContain("Open in Radioso");
  });

  it("escapes HTML in user-provided content", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      message: "<script>alert(1)</script>",
    });

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });
});
