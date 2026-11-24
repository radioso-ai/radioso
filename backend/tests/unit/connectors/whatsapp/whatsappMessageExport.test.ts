import { describe, expect, it } from "vitest";

import { exportedWhatsAppMessage } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageExport.js";

// Obviously fake numbers in the reserved 555-01xx range, in the form Meta reports `wa_id`.
const NUMBER_A = "15550100101";
const NUMBER_B = "15550100102";
const createdAt = new Date("2026-11-20T10:00:00.000Z");

/** One webhook delivery carrying a message from each of two senders, as Meta may batch them. */
const twoSenderBody = {
  object: "whatsapp_business_account",
  entry: [{
    id: "waba-1",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550100999", phone_number_id: "phone-number-1" },
        contacts: [
          { wa_id: NUMBER_A, profile: { name: "Ada Example" } },
          { wa_id: NUMBER_B, profile: { name: "Bea Example" } },
        ],
        messages: [
          { id: "wamid.a-text", from: NUMBER_A, timestamp: "1763632800", type: "text", text: { body: "A table for four, please" } },
          { id: "wamid.b-text", from: NUMBER_B, timestamp: "1763632801", type: "text", text: { body: "Bea's private question" } },
          { id: "wamid.a-photo", from: NUMBER_A, timestamp: "1763632802", type: "image", image: { id: "media-a-1", caption: "Our menu", mime_type: "image/jpeg" } },
          { id: "wamid.a-file", from: NUMBER_A, timestamp: "1763632803", type: "document", document: { id: "media-a-2", filename: "booking.pdf" } },
          { id: "wamid.b-photo", from: NUMBER_B, timestamp: "1763632804", type: "image", image: { id: "media-b-1", caption: "Bea's photo" } },
        ],
      },
    }],
  }],
  radioso: { visitor_images: [{ receipt: "internal-receipt" }] },
};

const inbound = (wamid: string, messageType: string) => exportedWhatsAppMessage({
  wamid, waId: NUMBER_A, direction: "inbound", messageType, status: "replied", payload: twoSenderBody, createdAt,
});

describe("a WhatsApp message in a data subject's export", () => {
  it("carries the subject's own message from a delivery that held another sender's", () => {
    const exported = [inbound("wamid.a-text", "text"), inbound("wamid.a-photo", "image"), inbound("wamid.a-file", "document")];

    expect(exported).toEqual([
      { number: `+${NUMBER_A}`, direction: "inbound", type: "text", status: "replied", createdAt: "2026-11-20T10:00:00.000Z", text: "A table for four, please" },
      { number: `+${NUMBER_A}`, direction: "inbound", type: "image", status: "replied", createdAt: "2026-11-20T10:00:00.000Z", text: "Our menu", media: { id: "media-a-1" } },
      { number: `+${NUMBER_A}`, direction: "inbound", type: "document", status: "replied", createdAt: "2026-11-20T10:00:00.000Z", media: { id: "media-a-2", filename: "booking.pdf" } },
    ]);
    const serialised = JSON.stringify(exported);
    for (const other of [NUMBER_B, "Bea", "media-b-1", "Ada Example", "phone-number-1", "15550100999", "internal-receipt"]) {
      expect(serialised).not.toContain(other);
    }
  });

  it("carries only what the row records when the delivery holds no message by its id", () => {
    expect(inbound("wamid.missing", "text")).toEqual({
      number: `+${NUMBER_A}`, direction: "inbound", type: "text", status: "replied", createdAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("never carries a message another number sent, even when the row names its id", () => {
    expect(JSON.stringify(inbound("wamid.b-text", "text"))).not.toContain("Bea");
  });

  it("carries a reply's text and none of the channel's own state", () => {
    const reply = exportedWhatsAppMessage({
      wamid: "local.outbound-1",
      waId: NUMBER_A,
      direction: "outbound",
      messageType: "interactive",
      status: "sent",
      payload: { text: "We have a table at eight.", inbound_wamids: ["wamid.a-text"], reply_cards: { messageId: "message-1", blocks: [] } },
      createdAt,
    });

    expect(reply).toEqual({
      number: `+${NUMBER_A}`, direction: "outbound", type: "interactive", status: "sent", createdAt: "2026-11-20T10:00:00.000Z", text: "We have a table at eight.",
    });
  });
});
