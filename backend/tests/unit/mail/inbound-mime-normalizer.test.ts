import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  InboundFetchError,
  normalizeInboundMime,
  type InboundProviderFacts,
} from "../../../src/modules/mail/public.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/", import.meta.url));
const RELAY_ADDRESS = "QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test";

const fixture = (path: string): Buffer => readFileSync(`${FIXTURES}${path}`);

const unknownFacts: InboundProviderFacts = {
  receivedFor: [],
  authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
  spamVerdict: "unknown",
};

const normalize = (path: string, facts: Partial<InboundProviderFacts> = {}) =>
  normalizeInboundMime(fixture(path), { ...unknownFacts, ...facts });

describe("normalizeInboundMime: identity and threading headers", () => {
  it("reads the message id, sender, recipients and subject of a first contact", async () => {
    const message = await normalize("mime/first-contact.eml");

    expect(message.rfcMessageId).toBe("<msg-0001@example.test>");
    expect(message.inReplyTo).toBeNull();
    expect(message.references).toEqual([]);
    expect(message.from).toEqual({ address: "alice@example.test", displayName: "Alice Carter" });
    expect(message.to).toEqual(["support@customer.test"]);
    expect(message.cc).toEqual([]);
    expect(message.subject).toBe("Question about my account");
    expect(message.text).toContain("update my billing address");
    expect(message.html).toBeNull();
  });

  it("reads In-Reply-To and every References id in order", async () => {
    const message = await normalize("mime/header-threaded-reply.eml");

    expect(message.inReplyTo).toBe("<out-0001@in.relay.test>");
    expect(message.references).toEqual(["<msg-0001@example.test>", "<out-0001@in.relay.test>"]);
  });

  it("lists every To address of a message addressed to two mailboxes", async () => {
    const message = await normalize("mime/two-mailbox.eml");

    expect(message.to).toEqual(["support@customer.test", "sales@customer.test"]);
  });

  it("reads a sender without a display name as a null display name", async () => {
    const raw = Buffer.from(
      "From: plain@example.test\r\nTo: support@customer.test\r\nSubject: Hi\r\n\r\nBody\r\n",
    );

    const message = await normalizeInboundMime(raw, unknownFacts);

    expect(message.from).toEqual({ address: "plain@example.test", displayName: null });
    expect(message.rfcMessageId).toBeNull();
  });

  it("decodes an encoded-word subject", async () => {
    const message = await normalize("mime/encoded-word-subject.eml");

    expect(message.subject).toBe("Rückfrage zu Bestellung: Preise für zwei Büros");
  });

  it("decodes a non-UTF-8 body into text", async () => {
    const message = await normalize("mime/iso-8859-1-body.eml");

    expect(message.text).toContain("¿cuándo llega el pedido número 482?");
    expect(message.text).toContain("María");
  });

  it("keeps the HTML body when there is no plain-text alternative", async () => {
    const message = await normalize("mime/html-only.eml");

    expect(message.text).toBeNull();
    expect(message.html).toContain("<p>Hi, the invoice link");
  });

  it("returns the raw bytes it was given", async () => {
    const raw = fixture("mime/first-contact.eml");

    const message = await normalizeInboundMime(raw, unknownFacts);

    expect(message.raw.equals(raw)).toBe(true);
  });
});

describe("normalizeInboundMime: the delivered-to set", () => {
  it("is the union of received_for, every Delivered-To and X-Original-To", async () => {
    const raw = Buffer.from(
      [
        "Delivered-To: first@in.relay.test",
        "X-Original-To: original@in.relay.test",
        "Delivered-To: support@customer.test",
        "From: alice@example.test",
        "To: support@customer.test",
        "Subject: Hi",
        "",
        "Body",
        "",
      ].join("\r\n"),
    );

    const message = await normalizeInboundMime(raw, {
      ...unknownFacts,
      receivedFor: ["envelope@in.relay.test"],
    });

    expect([...message.deliveredTo].sort()).toEqual(
      [
        "envelope@in.relay.test",
        "first@in.relay.test",
        "original@in.relay.test",
        "support@customer.test",
      ].sort(),
    );
  });

  it("keeps the relay address of a forwarded first contact, without duplicates", async () => {
    const message = await normalize("mime/first-contact.eml", { receivedFor: [RELAY_ADDRESS] });

    expect(message.deliveredTo).toContain(RELAY_ADDRESS);
    expect(message.deliveredTo).toContain("support@customer.test");
    expect(message.deliveredTo.filter((address) => address.toLowerCase() === RELAY_ADDRESS.toLowerCase())).toHaveLength(1);
  });

  it("keeps a plus-addressed Delivered-To as it arrived", async () => {
    const message = await normalize("mime/token-only-reply.eml");

    expect(message.deliveredTo).toContain("support+thrA7k2m9qzx4p@customer.test");
  });

  it("is only received_for when the message carries no delivery headers", async () => {
    const message = await normalize("mime/direct-receiving.eml", {
      receivedFor: ["care@receiving.customer.test"],
    });

    expect(message.deliveredTo).toEqual(["care@receiving.customer.test"]);
  });
});

describe("normalizeInboundMime: automation headers", () => {
  it.each([
    ["protocol/auto-submitted-auto-replied.eml", "autoSubmitted", "auto-replied"],
    ["protocol/auto-submitted-no.eml", "autoSubmitted", "no"],
    ["protocol/precedence-bulk.eml", "precedence", "bulk"],
    ["protocol/precedence-list.eml", "precedence", "list"],
    ["protocol/precedence-junk.eml", "precedence", "junk"],
    ["protocol/x-auto-response-suppress.eml", "autoResponseSuppress", "All"],
    ["protocol/list-id.eml", "listId", "Product Updates <updates.example.test>"],
  ] as const)("%s carries %s", async (path, field, value) => {
    const message = await normalize(path);

    expect(message.automation[field]).toBe(value);
  });

  it("reports every automation header as absent on a person's message", async () => {
    const message = await normalize("mime/first-contact.eml");

    expect(message.automation).toEqual({
      autoSubmitted: null,
      precedence: null,
      autoResponseSuppress: null,
      listId: null,
    });
  });
});

describe("normalizeInboundMime: delivery status reports", () => {
  it("reads the original Message-ID of a delivery-status report", async () => {
    const message = await normalize("protocol/dsn-radioso-id.eml");

    expect(message.report).toEqual({
      kind: "delivery_status",
      originalMessageIds: ["<out-0001@in.relay.test>"],
    });
  });

  it("reads a foreign original id the same way, leaving the judgement to classification", async () => {
    const message = await normalize("protocol/dsn-foreign-id.eml");

    expect(message.report?.originalMessageIds).toEqual(["<bulletin-55213@example.test>"]);
  });

  it("reads the original id from a text/rfc822-headers part", async () => {
    const raw = Buffer.from(
      [
        "From: mailer-daemon@mx.example.test",
        "To: relay@in.relay.test",
        "Subject: Undeliverable",
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type="Delivery-Status"; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "Failed.",
        "--b1",
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; mx.example.test",
        "",
        "Final-Recipient: rfc822; alice@example.test",
        "Action: failed",
        "Status: 5.1.1",
        "--b1",
        "Content-Type: text/rfc822-headers",
        "",
        "Message-ID: <out-0009@example.test>",
        "Subject: Re: Hello",
        "--b1--",
        "",
      ].join("\r\n"),
    );

    const message = await normalizeInboundMime(raw, unknownFacts);

    expect(message.report).toEqual({
      kind: "delivery_status",
      originalMessageIds: ["<out-0009@example.test>"],
    });
  });

  it("is null for a message that is not a delivery-status report", async () => {
    const message = await normalize("mime/attachments.eml");

    expect(message.report).toBeNull();
  });
});

describe("normalizeInboundMime: attachments manifest", () => {
  it("lists each attachment's name, type and decoded size, never its content", async () => {
    const message = await normalize("mime/attachments.eml");

    expect(message.attachments).toEqual([
      { name: "order-summary.txt", contentType: "text/plain", sizeBytes: 73 },
      { name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 125 },
    ]);
    expect(message.text).toContain("attaching my order summary");
    expect(message.text).not.toContain("Widget A");
  });

  it("is empty for a message without attachments", async () => {
    const message = await normalize("mime/first-contact.eml");

    expect(message.attachments).toEqual([]);
  });
});

describe("normalizeInboundMime: provider facts", () => {
  it("carries the provider's authentication results and spam verdict through", async () => {
    const message = await normalize("mime/first-contact.eml", {
      authentication: { spf: "pass", dkim: "fail", dmarc: "gray" },
      spamVerdict: "spam",
    });

    expect(message.authentication).toEqual({ spf: "pass", dkim: "fail", dmarc: "gray" });
    expect(message.spamVerdict).toBe("spam");
  });
});

describe("normalizeInboundMime: unparseable input", () => {
  it("raises a non-retryable fetch error when the MIME cannot be parsed", async () => {
    const nested = Array.from({ length: 300 }, (_, depth) => `Content-Type: multipart/mixed; boundary="d${depth}"\r\n\r\n--d${depth}\r\n`).join("");
    const raw = Buffer.from(`From: a@example.test\r\n${nested}`);

    const failure = await normalizeInboundMime(raw, unknownFacts).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable: false, code: "unparseable_mime" });
  });
});
