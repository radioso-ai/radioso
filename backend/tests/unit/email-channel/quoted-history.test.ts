import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  removeQuoteContainers,
  stripQuotedHistory,
} from "../../../src/modules/emailChannel/content/quotedHistory.js";
import { normalizeInboundMime } from "../../../src/modules/mail/public.js";

const MIME = fileURLToPath(new URL("../../fixtures/email-channel/mime/", import.meta.url));

const bodyOf = async (name: string) => {
  const message = await normalizeInboundMime(readFileSync(`${MIME}${name}`), {
    receivedFor: [],
    authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
    spamVerdict: "unknown",
  });
  return { text: message.text ?? "", html: message.html ?? "" };
};

const stripText = (text: string, priorOutboundTexts: readonly string[] = []) =>
  stripQuotedHistory({ text, priorOutboundTexts });

describe("stripQuotedHistory: trailing quote block (RFC 3676 quote prefix)", () => {
  it("cuts a Gmail plain-text quote and the attribution line ending in a colon", async () => {
    const { text } = await bodyOf("gmail-quoted-reply.eml");

    const result = stripText(text);

    expect(result).toEqual({
      text: "Thanks, I'll upgrade before Friday.",
      confidence: "confident",
      signals: ["quote_prefix_block"],
    });
  });

  it("cuts an Apple Mail quote whose attribution sits inside the quoted block", async () => {
    const { text } = await bodyOf("apple-quoted-reply.eml");

    const result = stripText(text);

    expect(result.confidence).toBe("confident");
    expect(result.text).toBe("Got it, downloading now - thank you!");
  });

  it("keeps the sign-off written below the quote", async () => {
    const { text } = await bodyOf("header-threaded-reply.eml");

    const result = stripText(text);

    expect(result.confidence).toBe("confident");
    expect(result.text.split("\n")).toEqual([
      "That worked, thank you! The billing address field was hiding under the",
      '"Advanced" tab.',
      "",
      "Alice",
    ]);
  });

  it("recognizes a German attribution by its structure, not its words", async () => {
    const { text } = await bodyOf("non-english-quoted-reply.eml");

    const result = stripText(text);

    expect(result.confidence).toBe("confident");
    expect(result.text).toBe("Danke, das klaert meine Frage vollstaendig.\n\nJorge");
  });

  it("recognizes an attribution in a script with no spaces between words", () => {
    const text = "了解しました。\n\n2026年10月3日 16:40 Support <support@customer.test>:\n> ご注文は発送されました。";

    const result = stripText(text);

    expect(result.confidence).toBe("confident");
    expect(result.text).toBe("了解しました。");
  });

  it("keeps a line ending in a colon when no quote block follows it", () => {
    const text = "Here is the error I see:\nPermission denied (code 13)";

    const result = stripText(text);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });

  it("does not strip quotes interleaved with answers", () => {
    const text = "> Which plan are you on?\nThe team plan.\n> How many seats?\nTwelve.";

    const result = stripText(text);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });

  it("keeps the full text when the body is nothing but a quote", () => {
    const text = "On Friday, Support wrote:\n> Your trial ends on Friday.";

    const result = stripText(text);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });
});

describe("stripQuotedHistory: signature separator (RFC 3676 sig-dash)", () => {
  it("cuts from the sig-dash line to the end", () => {
    const text = "Please cancel my order.\n\n-- \nDana Reyes\nOperations, Example Co.";

    const result = stripText(text);

    expect(result).toEqual({
      text: "Please cancel my order.",
      confidence: "confident",
      signals: ["signature_separator"],
    });
  });

  it("cuts the signature and a trailing quote together", () => {
    const text = "Yes, go ahead.\n-- \nDana\n\nOn Friday, Support wrote:\n> Shall we proceed?";

    const result = stripText(text);

    expect(result.confidence).toBe("confident");
    expect(result.text).toBe("Yes, go ahead.");
  });

  it("keeps the full text when the sig-dash opens the body", () => {
    const text = "-- \nDana Reyes";

    const result = stripText(text);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });
});

describe("stripQuotedHistory: verbatim cut of text Radioso sent on the thread", () => {
  const outlookPrior =
    "Hi Henry, invoice #2291 for 240.00 is now overdue. Let us know if you have any questions about it.";

  it("keeps an Outlook plain-text reply whole when nothing structural matches", async () => {
    const { text } = await bodyOf("outlook-quoted-reply.eml");

    const result = stripText(text);

    expect(result.confidence).toBe("full_text");
    expect(result.text).toContain("Thanks, I've paid the invoice now.");
    expect(result.text).toContain("is now overdue");
  });

  it("cuts an Outlook reply from the line where the rewrapped prior message begins", async () => {
    const { text } = await bodyOf("outlook-quoted-reply.eml");

    const result = stripText(text, [outlookPrior]);

    expect(result.confidence).toBe("confident");
    expect(result.signals).toEqual(["prior_outbound_text"]);
    expect(result.text).toContain("Thanks, I've paid the invoice now.");
    expect(result.text).not.toContain("is now overdue");
    expect(result.text).not.toContain("Let us know");
  });

  it("only cuts where the prior text begins a line", () => {
    const prior = "Your replacement card ships on Monday.";
    const text = `I was told "${prior}" but nothing arrived.`;

    const result = stripText(text, [prior]);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });

  it("ignores a prior message too short to identify the history", () => {
    const text = "Got it.\nThanks!\nOne more thing: can I change the address?";

    const result = stripText(text, ["Thanks!"]);

    expect(result).toEqual({ text, confidence: "full_text", signals: [] });
  });
});

describe("removeQuoteContainers: HTML quote markup", () => {
  it("removes a Gmail quote container", async () => {
    const { html } = await bodyOf("gmail-quoted-reply.eml");

    const result = removeQuoteContainers(html);

    expect(result.signals).toEqual(["quote_container"]);
    expect(result.html).toContain("upgrade before Friday");
    expect(result.html).not.toContain("reminder that your trial");
    expect(result.html).not.toContain("wrote:");
  });

  it("removes an Apple Mail cite blockquote", async () => {
    const { html } = await bodyOf("apple-quoted-reply.eml");

    const result = removeQuoteContainers(html);

    expect(result.signals).toEqual(["quote_container"]);
    expect(result.html).toContain("downloading now");
    expect(result.html).not.toContain("data export has finished");
  });

  it("removes a Thunderbird attribution and its cite blockquote", () => {
    const html =
      '<p>Works now.</p><div class="moz-cite-prefix">Support wrote:</div><blockquote type="cite"><p>Try again.</p></blockquote>';

    const result = removeQuoteContainers(html);

    expect(result.signals).toEqual(["quote_container"]);
    expect(result.html).toContain("Works now.");
    expect(result.html).not.toContain("Support wrote:");
    expect(result.html).not.toContain("Try again.");
  });

  it("removes a Yahoo quote container", () => {
    const html = '<div>Done.</div><div class="yahoo_quoted"><div>Please confirm.</div></div>';

    const result = removeQuoteContainers(html);

    expect(result.html).toContain("Done.");
    expect(result.html).not.toContain("Please confirm.");
  });

  it("cuts an Outlook reply from its history marker to the end", () => {
    const html = [
      "<html><body>",
      "<div>Paid, thanks.</div>",
      '<div id="appendonsend"></div>',
      "<hr>",
      '<div id="divRplyFwdMsg"><b>From:</b> Support</div>',
      "<div>Hi Henry, invoice #2291 is now overdue.</div>",
      "trailing history text",
      "</body></html>",
    ].join("");

    const result = removeQuoteContainers(html);

    expect(result.signals).toEqual(["quote_container"]);
    expect(result.html).toContain("Paid, thanks.");
    expect(result.html).not.toContain("<hr");
    expect(result.html).not.toContain("From:");
    expect(result.html).not.toContain("now overdue");
    expect(result.html).not.toContain("trailing history text");
  });

  it("leaves HTML without quote markup untouched", async () => {
    const { html } = await bodyOf("html-only.eml");

    const result = removeQuoteContainers(html);

    expect(result.signals).toEqual([]);
    expect(result.html).toContain("Could\nyou resend it as a PDF attachment instead?");
    expect(result.html).toContain("Erin");
  });
});

describe("stripQuotedHistory: signals found upstream in HTML", () => {
  it("is confident on a container signal alone and keeps the full text otherwise", () => {
    const confident = stripQuotedHistory({
      text: "Works now.",
      fullText: "Works now.\n\nSupport wrote:\nTry again.",
      signals: ["quote_container"],
      priorOutboundTexts: [],
    });
    const empty = stripQuotedHistory({
      text: "",
      fullText: "Support wrote:\nTry again.",
      signals: ["quote_container"],
      priorOutboundTexts: [],
    });

    expect(confident).toEqual({ text: "Works now.", confidence: "confident", signals: ["quote_container"] });
    expect(empty).toEqual({ text: "Support wrote:\nTry again.", confidence: "full_text", signals: [] });
  });
});
