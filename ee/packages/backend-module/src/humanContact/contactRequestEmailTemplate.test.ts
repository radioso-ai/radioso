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

  it("renders a Recent conversation section in chronological order when turns are provided", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      recentTurns: [
        { role: "user", content: "I have a billing question.", createdAt: new Date("2026-05-04T09:58:00.000Z") },
        { role: "assistant", content: "I could not find that in the indexed documents.", createdAt: new Date("2026-05-04T09:59:00.000Z") },
        { role: "user", content: "Can someone help me?", createdAt: new Date("2026-05-04T09:59:30.000Z") },
      ],
    });

    expect(message.text).toContain("Recent conversation:");
    expect(message.text).toContain("Visitor: I have a billing question.");
    expect(message.text).toContain("Assistant: I could not find that in the indexed documents.");
    expect(message.text).toContain("Visitor: Can someone help me?");
    const billingIdx = message.text.indexOf("I have a billing question");
    const helpIdx = message.text.indexOf("Can someone help me");
    expect(billingIdx).toBeLessThan(helpIdx);

    expect(message.html).toContain("Recent conversation");
    expect(message.html).toContain("I have a billing question.");
    expect(message.html).toContain("Can someone help me?");
  });

  it("omits the Recent conversation section when no turns are provided", () => {
    const message = renderHumanContactRequestEmail({ ...baseInput, recentTurns: [] });

    expect(message.text).not.toContain("Recent conversation");
    expect(message.html).not.toContain("Recent conversation");
  });

  it("truncates long turn content with an ellipsis", () => {
    const longContent = "a".repeat(500);
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      recentTurns: [{ role: "user", content: longContent, createdAt: new Date() }],
    });

    expect(message.text).toContain("…");
    expect(message.text).not.toContain("a".repeat(300));
  });

  it("escapes HTML inside conversation turns", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      recentTurns: [{ role: "user", content: "<img src=x onerror=alert(1)>", createdAt: new Date() }],
    });

    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });
});
