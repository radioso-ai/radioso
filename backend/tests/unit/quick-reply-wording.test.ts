import { describe, expect, it } from "vitest";

import {
  authoredMechanicsLine,
  plannerQuickReplyTextRejection,
} from "../../src/modules/chat/services/quickReplyWording.js";

describe("planner quick-reply text gate", () => {
  it.each([
    "Hello! How can I help you today?",
    "You're welcome!",
    "Ciao! Come posso aiutarti?",
    "こんにちは！ご用件をどうぞ。",
  ])("passes %j", (text) => {
    expect(plannerQuickReplyTextRejection(text)).toBeNull();
  });

  it.each([
    ["Welcome! Pro costs $99 and is SOC 2 certified.", "digit"],
    ["We open at ٩ tomorrow.", "digit"],
    ["Plans start at €.", "currency"],
    ["See https://acme.example for more.", "link"],
    ["See mailto:help for more.", "link"],
    ["Visit www.acme for help.", "link"],
    ["Write to help@acme.example for help.", "email"],
  ])("rejects %j as %s", (text, reason) => {
    expect(plannerQuickReplyTextRejection(text)).toBe(reason);
  });

  it("checks format only: a claim without digits, currency, or link syntax passes, which is why authored lines are the guarantee", () => {
    expect(plannerQuickReplyTextRejection("Hello! We are certified and open on Sundays.")).toBeNull();
  });
});

describe("authored mechanics lines", () => {
  const replies = {
    en: { greeting: ["Hi! What can I help with?", "Hello! What brings you here?"], thanks: [], farewell: [], acknowledgement: [] },
    "it-IT": { greeting: ["Ciao! Come posso aiutarti?"], thanks: ["Prego!"], farewell: [], acknowledgement: [] },
    it: { greeting: ["Ciao!"], thanks: ["Grazie a te!"], farewell: ["Arrivederci!"], acknowledgement: [] },
  };

  it("matches the planner's language tag in full first, then its primary subtag", () => {
    expect(authoredMechanicsLine({ replies, kind: "thanks", language: "it-IT", rotation: 0 })).toBe("Prego!");
    expect(authoredMechanicsLine({ replies, kind: "farewell", language: "it-IT", rotation: 0 })).toBe("Arrivederci!");
    expect(authoredMechanicsLine({ replies, kind: "farewell", language: "it-CH", rotation: 0 })).toBe("Arrivederci!");
  });

  it("never widens a bare language to a regional tag", () => {
    expect(authoredMechanicsLine({ replies, kind: "thanks", language: "it", rotation: 0 })).toBe("Grazie a te!");
    expect(authoredMechanicsLine({ replies, kind: "acknowledgement", language: "it", rotation: 0 })).toBeNull();
  });

  it("matches tags case-insensitively", () => {
    expect(authoredMechanicsLine({ replies, kind: "thanks", language: "IT-it", rotation: 0 })).toBe("Prego!");
  });

  it("rotates through the authored lines", () => {
    expect(authoredMechanicsLine({ replies, kind: "greeting", language: "en", rotation: 0 })).toBe("Hi! What can I help with?");
    expect(authoredMechanicsLine({ replies, kind: "greeting", language: "en", rotation: 1 })).toBe("Hello! What brings you here?");
    expect(authoredMechanicsLine({ replies, kind: "greeting", language: "en", rotation: 2 })).toBe("Hi! What can I help with?");
  });

  it("returns nothing for a mechanic, language, or agent with no authored line", () => {
    expect(authoredMechanicsLine({ replies, kind: "thanks", language: "en", rotation: 0 })).toBeNull();
    expect(authoredMechanicsLine({ replies, kind: "greeting", language: "de", rotation: 0 })).toBeNull();
    expect(authoredMechanicsLine({ replies: {}, kind: "greeting", language: "en", rotation: 0 })).toBeNull();
  });
});
