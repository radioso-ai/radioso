import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

import { classifyInbound } from "../../../src/modules/connectors/plugins/email/emailInboundClassification.js";
import type { InboundEmailMessage } from "../../../src/modules/mail/public.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/email-channel/", import.meta.url));
const RELAY_ADDRESS = "qz2k7xn4vtm3rlhjwpc6ygbsfd@in.relay.test";
const OWN_ADDRESSES: ReadonlySet<string> = new Set(["support@customer.test", "sales@customer.test", RELAY_ADDRESS]);
const RADIOSO_OUTBOUND_IDS: ReadonlySet<string> = new Set(["out-0001@in.relay.test"]);
const isRadiosoOutboundId = (id: string) => RADIOSO_OUTBOUND_IDS.has(id);

type ClassifierMessage = Parameters<typeof classifyInbound>[0]["message"];

const withoutAngleBrackets = (id: string) => id.trim().replace(/^<(.*)>$/, "$1");

// Reads only the typed header facts the classifier sees, the way the inbound normalizer exposes
// them (contracts/ports.md §1b). Header names and the report content type are protocol syntax.
const messageFromFixture = async (relativePath: string): Promise<ClassifierMessage> => {
  const raw = readFileSync(`${FIXTURE_ROOT}${relativePath}`);
  const email = await PostalMime.parse(raw, { forceRfc822Attachments: true });
  const header = (key: string) => email.headers.find((entry) => entry.key === key)?.value ?? null;
  const contentType = (header("content-type") ?? "").toLowerCase();
  const isDeliveryStatusReport = contentType.startsWith("multipart/report")
    && /report-type\s*=\s*"?delivery-status"?/.test(contentType);
  const originalMessageIds: string[] = [];
  if (isDeliveryStatusReport) {
    for (const attachment of email.attachments) {
      if (attachment.mimeType !== "message/rfc822" && attachment.mimeType !== "text/rfc822-headers") continue;
      const original = await PostalMime.parse(attachment.content);
      if (original.messageId) originalMessageIds.push(withoutAngleBrackets(original.messageId));
    }
  }
  const from = email.from?.address ? { address: email.from.address, displayName: email.from.name || null } : null;
  return {
    from,
    automation: {
      autoSubmitted: header("auto-submitted"),
      precedence: header("precedence"),
      autoResponseSuppress: header("x-auto-response-suppress"),
      listId: header("list-id"),
    },
    report: isDeliveryStatusReport ? { kind: "delivery_status", originalMessageIds } : null,
    spamVerdict: "unknown",
  };
};

const person: ClassifierMessage = {
  from: { address: "alice@example.test", displayName: "Alice Carter" },
  automation: { autoSubmitted: null, precedence: null, autoResponseSuppress: null, listId: null },
  report: null,
  spamVerdict: "unknown",
};

const classify = (message: ClassifierMessage) =>
  classifyInbound({ message, ownAddresses: OWN_ADDRESSES, isRadiosoOutboundId });

const withAutomation = (automation: Partial<ClassifierMessage["automation"]>): ClassifierMessage => ({
  ...person,
  automation: { ...person.automation, ...automation },
});

describe("classifyInbound", () => {
  describe("protocol fixture corpus", () => {
    it.each([
      ["auto-submitted-auto-replied.eml", "automated_sender", []],
      ["auto-submitted-no.eml", "person", []],
      ["precedence-bulk.eml", "automated_sender", []],
      ["precedence-list.eml", "automated_sender", []],
      ["precedence-junk.eml", "automated_sender", []],
      ["x-auto-response-suppress.eml", "automated_sender", []],
      ["list-id.eml", "automated_sender", []],
      ["dsn-radioso-id.eml", "bounce", ["out-0001@in.relay.test"]],
      ["dsn-foreign-id.eml", "automated_sender", []],
      ["self-sender.eml", "self_sender", []],
    ] as const)("classifies protocol/%s as %s", async (file, classification, bouncedOutboundIds) => {
      expect(classify(await messageFromFixture(`protocol/${file}`))).toEqual({ classification, bouncedOutboundIds });
    });

    it("covers every file in the protocol corpus", () => {
      expect(readdirSync(`${FIXTURE_ROOT}protocol`).filter((name) => name.endsWith(".eml")).sort()).toEqual([
        "auto-submitted-auto-replied.eml",
        "auto-submitted-no.eml",
        "dsn-foreign-id.eml",
        "dsn-radioso-id.eml",
        "list-id.eml",
        "precedence-bulk.eml",
        "precedence-junk.eml",
        "precedence-list.eml",
        "self-sender.eml",
        "x-auto-response-suppress.eml",
      ]);
    });

    it("classifies every customer message in the MIME corpus as a person", async () => {
      // outlook-quoted-reply.eml quotes `From: Support <support@customer.test>` in its body, which
      // must not read as a self-sender.
      const files = readdirSync(`${FIXTURE_ROOT}mime`).filter((name) => name.endsWith(".eml"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(classify(await messageFromFixture(`mime/${file}`)), file).toEqual({
          classification: "person",
          bouncedOutboundIds: [],
        });
      }
    });
  });

  describe("rule order: self_sender, bounce, automation headers, spam", () => {
    const radiosoBounce = { kind: "delivery_status" as const, originalMessageIds: ["out-0001@in.relay.test"] };

    it("puts self_sender before a delivery report", () => {
      expect(classify({ ...person, from: { address: "support@customer.test", displayName: null }, report: radiosoBounce }))
        .toEqual({ classification: "self_sender", bouncedOutboundIds: [] });
    });

    it("puts a bounce before automation headers", () => {
      expect(classify({ ...withAutomation({ autoSubmitted: "auto-replied", listId: "x" }), report: radiosoBounce }))
        .toEqual({ classification: "bounce", bouncedOutboundIds: ["out-0001@in.relay.test"] });
    });

    it("puts automation headers before the spam verdict", () => {
      expect(classify({ ...withAutomation({ precedence: "bulk" }), spamVerdict: "spam" }))
        .toEqual({ classification: "automated_sender", bouncedOutboundIds: [] });
    });

    it("reads a foreign delivery report as automated before the spam verdict", () => {
      expect(classify({ ...person, report: { kind: "delivery_status", originalMessageIds: ["x@example.test"] }, spamVerdict: "spam" }))
        .toEqual({ classification: "automated_sender", bouncedOutboundIds: [] });
    });

    it("puts the spam verdict before person", () => {
      expect(classify({ ...person, spamVerdict: "spam" })).toEqual({ classification: "spam", bouncedOutboundIds: [] });
    });
  });

  describe("self_sender", () => {
    it("matches a workspace mailbox address and a relay address, case-insensitively", () => {
      for (const address of ["support@customer.test", "Sales@Customer.TEST", RELAY_ADDRESS.toUpperCase()]) {
        expect(classify({ ...person, from: { address, displayName: null } }).classification).toBe("self_sender");
      }
    });

    it("does not match another address on the same domain", () => {
      expect(classify({ ...person, from: { address: "billing@customer.test", displayName: null } }).classification).toBe("person");
    });

    it("skips the rule when the message names no sender", () => {
      expect(classify({ ...person, from: null }).classification).toBe("person");
    });
  });

  describe("bounce", () => {
    it("lists only the Radioso outbound ids the report names", () => {
      expect(classify({
        ...person,
        report: { kind: "delivery_status", originalMessageIds: ["x@example.test", "out-0001@in.relay.test"] },
      })).toEqual({ classification: "bounce", bouncedOutboundIds: ["out-0001@in.relay.test"] });
    });

    it("reads a report that names no original message as automated", () => {
      expect(classify({ ...person, report: { kind: "delivery_status", originalMessageIds: [] } }))
        .toEqual({ classification: "automated_sender", bouncedOutboundIds: [] });
    });
  });

  describe("automation headers as protocol tokens", () => {
    it("gives person for Auto-Submitted: no, in any case, with parameters or comments", () => {
      for (const value of ["no", "No", " NO ", "no; reason=x", "no (sent by a person)"]) {
        expect(classify(withAutomation({ autoSubmitted: value })).classification, value).toBe("person");
      }
    });

    it("gives automated_sender for any other Auto-Submitted value", () => {
      for (const value of ["auto-replied", "AUTO-GENERATED", "auto-notified; owner-email=a@example.test", "x-custom", ""]) {
        expect(classify(withAutomation({ autoSubmitted: value })).classification, value).toBe("automated_sender");
      }
    });

    it("gives automated_sender for the RFC 2076 Precedence tokens only", () => {
      for (const value of ["bulk", "List", "JUNK", " bulk "]) {
        expect(classify(withAutomation({ precedence: value })).classification, value).toBe("automated_sender");
      }
      for (const value of ["first-class", "normal", "bulky", ""]) {
        expect(classify(withAutomation({ precedence: value })).classification, value).toBe("person");
      }
    });

    it("gives automated_sender whenever X-Auto-Response-Suppress or List-Id is present", () => {
      for (const value of ["All", "OOF, AutoReply", ""]) {
        expect(classify(withAutomation({ autoResponseSuppress: value })).classification).toBe("automated_sender");
        expect(classify(withAutomation({ listId: value })).classification).toBe("automated_sender");
      }
    });
  });

  describe("spam verdict", () => {
    it("treats unknown and not_spam as not spam", () => {
      expect(classify({ ...person, spamVerdict: "unknown" }).classification).toBe("person");
      expect(classify({ ...person, spamVerdict: "not_spam" }).classification).toBe("person");
    });
  });

  describe("signals it never reads", () => {
    const fullMessage = (overrides: Partial<InboundEmailMessage>): InboundEmailMessage => ({
      rfcMessageId: "msg-9000@example.test",
      inReplyTo: null,
      references: [],
      from: { address: "alice@example.test", displayName: "Alice Carter" },
      to: ["support@customer.test"],
      cc: [],
      deliveredTo: [RELAY_ADDRESS],
      subject: "Question",
      text: "Hello",
      html: null,
      automation: { autoSubmitted: null, precedence: null, autoResponseSuppress: null, listId: null },
      report: null,
      attachments: [],
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      spamVerdict: "unknown",
      raw: Buffer.from(""),
      ...overrides,
    });

    it("never changes the result on authentication failures", () => {
      for (const verdict of ["fail", "gray", "processing_failed", "unknown"] as const) {
        const message = fullMessage({ authentication: { spf: verdict, dkim: verdict, dmarc: verdict } });
        expect(classify(message)).toEqual({ classification: "person", bouncedOutboundIds: [] });
      }
    });

    it("gives person for a subject and body full of automation-like words", () => {
      const message = fullMessage({
        subject: "Automatic reply: Out of office (auto-generated, bulk, list, junk)",
        text: "Auto-Submitted: auto-replied\nPrecedence: bulk\nList-Id: <x.example.test>\nI am out of the office.",
        html: "<p>Delivery Status Notification (Failure) mailer-daemon</p>",
      });
      expect(classify(message)).toEqual({ classification: "person", bouncedOutboundIds: [] });
    });
  });
});
