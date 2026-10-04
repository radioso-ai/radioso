import { describe, expect, it } from "vitest";

import { renderAccountInvitationEmail } from "../../../src/modules/mail/templates/accountInvitationEmail.js";

describe("renderAccountInvitationEmail", () => {
  it("addresses the invitee and links to the acceptance URL", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: "owner@example.com",
      invitedByName: null,
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(message.to).toBe("teammate@example.com");
    expect(message.subject).toContain("Radioso");
    expect(message.text).toContain("https://app.radioso.ai/invite/token-123");
    expect(message.text).toContain("owner@example.com");
    expect(message.html).toContain("https://app.radioso.ai/invite/token-123");
    expect(message.kind).toBe("account_invitation");
  });

  it("names the inviter by display name with their address beside it", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: "owner@example.com",
      invitedByName: "Olivia Owner",
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(message.text).toContain("Olivia Owner (owner@example.com) invited you");
    expect(message.html).toContain("Olivia Owner (owner@example.com) invited you");
  });

  it("escapes the inviter's display name in the HTML body", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: "owner@example.com",
      invitedByName: "<b>Olivia</b>",
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(message.html).not.toContain("<b>Olivia</b>");
    expect(message.html).toContain("&lt;b&gt;Olivia&lt;/b&gt;");
  });

  it("omits the inviter when it cannot be resolved", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: null,
      invitedByName: null,
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(message.text).not.toContain("null");
    expect(message.html).not.toContain("null");
  });

  it("escapes inviter-controlled values in the HTML body", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: '"><script>alert(1)</script>',
      invitedByName: null,
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("keeps the acceptance URL out of logged metadata", () => {
    const message = renderAccountInvitationEmail({
      to: "teammate@example.com",
      acceptanceUrl: "https://app.radioso.ai/invite/token-123",
      invitedByEmail: null,
      invitedByName: null,
      expiresAt: new Date("2026-09-09T10:00:00.000Z"),
    });

    expect(JSON.stringify(message.metadata ?? {})).not.toContain("token-123");
  });
});
