import { describe, expect, it } from "vitest";

import {
  buildOutboundHeaders,
  REFERENCES_LIMIT,
  replySubject,
  replyToAddress,
} from "../../../src/modules/emailChannel/outbound/outboundHeaders.js";
import { EmailHeaderValueError, parseRfcMessageId, rfcMessageId } from "../../../src/modules/mail/public.js";

const MESSAGE_UUID = "6f1c2a4e-9b3d-4c8e-a1f2-3d4e5f6a7b8c";
const THREAD_TOKEN = "MFRGGZDFMZTWQ2LKNNWG23TPOA";

const ids = (count: number, prefix = "ref"): ReturnType<typeof rfcMessageId>[] =>
  Array.from({ length: count }, (_, index) => rfcMessageId(`<${prefix}-${index}@mail.customer.test>`));

const headersFor = (overrides: Partial<Parameters<typeof buildOutboundHeaders>[0]> = {}) =>
  buildOutboundHeaders({
    sendingDomain: "acme.test",
    latestInbound: { rfcMessageId: rfcMessageId("<parent@mail.customer.test>"), references: [] },
    authorKind: "operator",
    newMessageUuid: MESSAGE_UUID,
    ...overrides,
  });

describe("buildOutboundHeaders: Message-ID", () => {
  it("generates a well-formed id on the sending domain from the new message's UUID", () => {
    const headers = headersFor();

    expect(headers.messageId).toBe(`<${MESSAGE_UUID}@acme.test>`);
    expect(parseRfcMessageId(headers.messageId)).toBe(headers.messageId);
  });

  it("lowercases the sending domain", () => {
    expect(headersFor({ sendingDomain: "Mail.ACME.test" }).messageId).toBe(`<${MESSAGE_UUID}@mail.acme.test>`);
  });

  it("gives two messages two ids", () => {
    expect(headersFor().messageId).not.toBe(headersFor({ newMessageUuid: "0b7c2f8e-1d4a-4e6b-9c3d-2a1b0c9d8e7f" }).messageId);
  });

  it.each([
    ["a line break", "acme.test\r\nBcc: x@evil.test"],
    ["whitespace", "acme .test"],
    ["an address", "x@acme.test"],
    ["angle brackets", "acme.test>"],
    ["nothing", ""],
  ])("rejects a sending domain with %s", (_label, sendingDomain) => {
    expect(() => headersFor({ sendingDomain })).toThrow(EmailHeaderValueError);
  });

  it.each(["not-a-uuid", `${MESSAGE_UUID}\r\n`, "", `${MESSAGE_UUID}@evil.test`])(
    "rejects %j as the new message UUID",
    (newMessageUuid) => {
      expect(() => headersFor({ newMessageUuid })).toThrow();
    },
  );
});

describe("buildOutboundHeaders: threading", () => {
  it("replies to the latest inbound message and appends it to its references", () => {
    const [root, middle] = ids(2);
    const headers = headersFor({
      latestInbound: { rfcMessageId: rfcMessageId("<parent@mail.customer.test>"), references: [root, middle] },
    });

    expect(headers.inReplyTo).toBe("<parent@mail.customer.test>");
    expect(headers.references).toEqual([root, middle, "<parent@mail.customer.test>"]);
  });

  it("starts the references with the parent when the parent carried none", () => {
    expect(headersFor().references).toEqual(["<parent@mail.customer.test>"]);
  });

  it("keeps the parent's references but sets no In-Reply-To when the parent had no Message-ID", () => {
    const [root] = ids(1);
    const headers = headersFor({ latestInbound: { rfcMessageId: null, references: [root] } });

    expect(headers.inReplyTo).toBeNull();
    expect(headers.references).toEqual([root]);
  });

  it("sets no threading headers at all when there is nothing to thread on", () => {
    const headers = headersFor({ latestInbound: { rfcMessageId: null, references: [] } });

    expect(headers.inReplyTo).toBeNull();
    expect(headers.references).toEqual([]);
  });

  it("lists each id once, at its first position", () => {
    const [root, middle] = ids(2);
    const parent = rfcMessageId("<parent@mail.customer.test>");
    const headers = headersFor({ latestInbound: { rfcMessageId: parent, references: [root, middle, root, parent] } });

    expect(headers.references).toEqual([root, middle, parent]);
  });

  it(`trims a long chain to ${REFERENCES_LIMIT} ids, keeping the root and the newest`, () => {
    const chain = ids(40);
    const parent = rfcMessageId("<parent@mail.customer.test>");
    const headers = headersFor({ latestInbound: { rfcMessageId: parent, references: chain } });

    expect(headers.references).toHaveLength(REFERENCES_LIMIT);
    expect(headers.references[0]).toBe(chain[0]);
    expect(headers.references.at(-1)).toBe(parent);
    expect(headers.references.slice(1)).toEqual([...chain.slice(40 - (REFERENCES_LIMIT - 2)), parent]);
  });

  it("does not trim a chain at the limit", () => {
    const chain = ids(REFERENCES_LIMIT - 1);
    const parent = rfcMessageId("<parent@mail.customer.test>");

    expect(headersFor({ latestInbound: { rfcMessageId: parent, references: chain } }).references)
      .toEqual([...chain, parent]);
  });
});

describe("buildOutboundHeaders: Auto-Submitted (RFC 3834, FR-034)", () => {
  it("marks agent-authored mail auto-generated", () => {
    expect(headersFor({ authorKind: "agent" }).autoSubmitted).toBe("auto-generated");
  });

  it("never marks operator-authored mail", () => {
    expect(headersFor({ authorKind: "operator" }).autoSubmitted).toBeNull();
  });
});

describe("replySubject", () => {
  it.each([
    ["Order 42 has not arrived", "Re: Order 42 has not arrived"],
    ["Re: Order 42", "Re: Order 42"],
    ["RE: Order 42", "RE: Order 42"],
    ["re:Order 42", "re:Order 42"],
    ["Re : Order 42", "Re: Re : Order 42"],
    ["Fwd: Order 42", "Re: Fwd: Order 42"],
    ["AW: Bestellung 42", "Re: AW: Bestellung 42"],
    ["Заказ 42", "Re: Заказ 42"],
    ["Order Re: 42", "Re: Order Re: 42"],
  ])("continues %j as %j", (latest, expected) => {
    expect(replySubject(latest)).toBe(expected);
  });

  it.each([null, "", "   "])("replies to a missing subject (%j) with the bare prefix", (latest) => {
    expect(replySubject(latest)).toBe("Re:");
  });

  it("collapses line breaks and control characters, so the subject stays one header line", () => {
    expect(replySubject("Order\r\n 42\tlate\u0000")).toBe("Re: Order 42 late");
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(replySubject("  Re: Order 42  ")).toBe("Re: Order 42");
  });
});

describe("replyToAddress (A9: the plus token only after the setup check proved it)", () => {
  it("adds the thread token as a plus tag once plus addressing is verified", () => {
    expect(replyToAddress({ address: "support@acme.test", plusAddressVerified: true }, THREAD_TOKEN))
      .toBe(`support+${THREAD_TOKEN}@acme.test`);
  });

  it("uses the bare mailbox address while plus addressing is unverified", () => {
    expect(replyToAddress({ address: "support@acme.test", plusAddressVerified: false }, THREAD_TOKEN))
      .toBe("support@acme.test");
  });

  it.each(["", "TOKEN@evil.test", "TOKEN\r\nBcc: x@evil.test", "TO KEN", "TOKEN+MORE"])(
    "rejects the thread token %j",
    (threadToken) => {
      expect(() => replyToAddress({ address: "support@acme.test", plusAddressVerified: true }, threadToken)).toThrow();
    },
  );

  it.each([true, false])("rejects a mailbox address that is not header-safe (plus verified: %s)", (plusAddressVerified) => {
    expect(() => replyToAddress({ address: "support@acme.test\r\nBcc: x@evil.test", plusAddressVerified }, THREAD_TOKEN))
      .toThrow(EmailHeaderValueError);
  });

  it("never echoes the thread token in a rejection", () => {
    try {
      replyToAddress({ address: "support@acme.test", plusAddressVerified: true }, `${THREAD_TOKEN}\n`);
    } catch (error) {
      expect(String(error)).not.toContain(THREAD_TOKEN);
      return;
    }
    throw new Error("expected the token to be rejected");
  });
});
