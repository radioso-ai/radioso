import { describe, expect, it } from "vitest";

import { renderEmail, renderEmailText } from "../../../src/modules/mail/templates/layout.js";

const content = {
  preheader: "Confirm the address so we know it reaches you.",
  heading: "Verify your email",
  paragraphs: ["Welcome to Radioso."],
  cta: { href: "https://app.radioso.ai/verify-email?token=abc", label: "Verify email address" },
  footnote: "If you did not create this account, you can ignore this email.",
};

describe("renderEmail", () => {
  it("renders a complete HTML document rather than a fragment", () => {
    const html = renderEmail(content);

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("</html>");
  });

  it("opens with the preheader so inbox previews read as a sentence", () => {
    const html = renderEmail(content);
    const preheaderIndex = html.indexOf("Confirm the address so we know it reaches you.");

    expect(preheaderIndex).toBeGreaterThan(-1);
    // Ahead of the visible heading, not merely ahead of the <title>.
    expect(preheaderIndex).toBeLessThan(html.indexOf("<h1"));
  });

  it("uses the Radioso brand colours rather than a generic neutral", () => {
    const html = renderEmail(content);

    // Brand blue passes AA on white; the app's lighter #5096E7 does not.
    expect(html).toContain("#2870BD");
    expect(html).toContain("#142317");
    expect(html).not.toContain("#111827");
  });

  it("serves the brand lockup from the configured app origin", () => {
    const html = renderEmail(content, { appBaseUrl: "https://app.radioso.ai" });

    expect(html).toContain('src="https://app.radioso.ai/radioso-lockup-email.png"');
    expect(html).toContain('src="https://app.radioso.ai/radioso-lockup-email-dark.png"');
  });

  it("names the logo so an image-blocking client still reads the brand", () => {
    const html = renderEmail(content);
    const logoTags = html.match(/<img[^>]*>/g) ?? [];

    expect(logoTags).toHaveLength(2);
    for (const tag of logoTags) {
      expect(tag).toContain('alt="Radioso"');
    }
  });

  it("reveals only one lockup when a client drops the stylesheet", () => {
    const html = renderEmail(content);

    // The dark lockup is hidden inline and only the media query shows it, so a client that
    // strips <style> renders the light one alone rather than stacking both.
    expect(html).toMatch(/class="r-logo-dark"[^>]*style="display:none/);
    expect(html).toContain(".r-logo-dark { display:block !important; }");
  });

  it("carries the positioning line in the footer", () => {
    const html = renderEmail(content);

    expect(html).toContain("All your conversational agents. One platform you own.");
  });

  it("links the call to action", () => {
    const html = renderEmail(content);

    expect(html).toContain('href="https://app.radioso.ai/verify-email?token=abc"');
    expect(html).toContain("Verify email address");
  });

  it("omits the call to action when a message has none", () => {
    const html = renderEmail({ ...content, cta: undefined }, { appBaseUrl: "https://app.radioso.ai" });

    expect(html).not.toContain("verify-email?token=abc");
    expect(html).not.toContain("Verify email address");
  });

  it("escapes copy and links supplied by a template", () => {
    const html = renderEmail({
      ...content,
      heading: "<script>alert(1)</script>",
      paragraphs: ["owner+<b>@example.com invited you."],
      cta: { href: "https://example.com/?a=1&b=2", label: "Open <link>" },
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("owner+&lt;b&gt;@example.com invited you.");
    expect(html).toContain("Open &lt;link&gt;");
    expect(html).toContain("https://example.com/?a=1&amp;b=2");
  });

  it("renders meta rows as a labelled list when a template supplies them", () => {
    const html = renderEmail({
      ...content,
      metaRows: [{ label: "Expires", value: "9 September 2026" }],
    });

    expect(html).toContain("Expires");
    expect(html).toContain("9 September 2026");
  });

  it("declares dark mode support so clients do not invert the palette themselves", () => {
    const html = renderEmail(content);

    expect(html).toContain("color-scheme");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("constrains the body to a readable column", () => {
    expect(renderEmail(content)).toContain("600");
  });
});

describe("renderEmailText", () => {
  it("mirrors the HTML content as plaintext with the link inline", () => {
    const text = renderEmailText(content);

    expect(text).toContain("Welcome to Radioso.");
    expect(text).toContain("https://app.radioso.ai/verify-email?token=abc");
    expect(text).toContain("If you did not create this account, you can ignore this email.");
    expect(text).toContain("All your conversational agents. One platform you own.");
    expect(text).not.toContain("<");
  });
});
