import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractCustomerText } from "../../../src/modules/emailChannel/content/customerText.js";
import { normalizeInboundMime } from "../../../src/modules/mail/public.js";

const MIME = fileURLToPath(new URL("../../fixtures/email-channel/mime/", import.meta.url));

const messageOf = (name: string) =>
  normalizeInboundMime(readFileSync(`${MIME}${name}`), {
    receivedFor: [],
    authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
    spamVerdict: "unknown",
  });

describe("extractCustomerText: body source", () => {
  it("converts an HTML-only body to plain text with its paragraphs and line breaks", async () => {
    const message = await messageOf("html-only.eml");

    const result = extractCustomerText(message, []);

    expect(result.confidence).toBe("full_text");
    expect(result.text).not.toMatch(/<[a-z/]/i);
    expect(result.text.split("\n")).toEqual([
      "Hi, the invoice link in my last email just shows a blank page. Could you resend it as a PDF attachment instead?",
      "",
      "Thanks,",
      "Erin",
    ]);
  });

  it("prefers the plain-text alternative over the HTML one", async () => {
    const message = await messageOf("gmail-quoted-reply.eml");

    const result = extractCustomerText(message, []);

    expect(result).toMatchObject({ text: "Thanks, I'll upgrade before Friday.", confidence: "confident" });
  });

  it("strips HTML quote markup from an HTML-only reply", async () => {
    const message = await messageOf("apple-quoted-reply.eml");

    const result = extractCustomerText({ ...message, text: null }, []);

    expect(result).toMatchObject({ text: "Got it, downloading now - thank you!", confidence: "confident" });
  });

  it("keeps the full converted text of an HTML-only body that is entirely quoted", () => {
    const html = '<blockquote type="cite"><div>Your order shipped.</div></blockquote>';

    const result = extractCustomerText({ subject: null, text: null, html }, []);

    expect(result.confidence).toBe("full_text");
    expect(result.text).toContain("Your order shipped.");
  });

  it("cuts the history Radioso sent from an HTML-only body", () => {
    const prior = "Your replacement card ships on Monday from our warehouse.";
    const html = `<div>It arrived, thanks.</div><hr><div>${prior}</div>`;

    const result = extractCustomerText({ subject: null, text: null, html }, [prior]);

    expect(result).toMatchObject({ text: "It arrived, thanks.", confidence: "confident" });
  });

  it("falls back to the HTML body when the plain-text part is blank", () => {
    const result = extractCustomerText(
      { subject: null, text: " \n", html: "<p>Only in HTML.</p>" },
      [],
    );

    expect(result.text).toBe("Only in HTML.");
  });
});

describe("extractCustomerText: character sets and encoded words", () => {
  it("keeps the accented text of an ISO-8859-1 body", async () => {
    const message = await messageOf("iso-8859-1-body.eml");

    const result = extractCustomerText(message, []);

    expect(result.confidence).toBe("full_text");
    expect(result.text).toContain("Tenemos una pregunta más sobre nuestro pedido: ¿cuándo llega el pedido número 482?");
    expect(result.text).toContain("María");
  });

  it("returns the decoded encoded-word subject", async () => {
    const message = await messageOf("encoded-word-subject.eml");

    const result = extractCustomerText(message, []);

    expect(result.subject).toBe("Rückfrage zu Bestellung: Preise für zwei Büros");
    expect(result.text).toContain("could you send pricing for two offices?");
  });

  it("collapses folded whitespace in the subject and reads a blank subject as none", () => {
    const folded = extractCustomerText({ subject: "Order\r\n\t #4471  question", text: "Hi", html: null }, []);
    const blank = extractCustomerText({ subject: "  ", text: "Hi", html: null }, []);

    expect(folded.subject).toBe("Order #4471 question");
    expect(blank.subject).toBeNull();
  });
});

describe("extractCustomerText: empty bodies", () => {
  it("is empty full text when the message has no body", () => {
    const result = extractCustomerText({ subject: "Call me", text: null, html: null }, []);

    expect(result).toEqual({ subject: "Call me", text: "", confidence: "full_text" });
  });

  it("is empty full text when the HTML body has no visible text", () => {
    const result = extractCustomerText(
      { subject: null, text: null, html: '<html><body><img src="cid:logo"></body></html>' },
      [],
    );

    expect(result).toEqual({ subject: null, text: "", confidence: "full_text" });
  });
});
