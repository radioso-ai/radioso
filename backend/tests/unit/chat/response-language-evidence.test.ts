import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import { responseLanguageEvidence } from "../../../src/modules/chat/services/responseLanguageEvidence.js";

// A pick is language-neutral (#1763): a card's title is the page's or the record's own text, in
// whatever language it is written in, so the reply's language follows what the visitor wrote.

const message = (id: string, role: MessageRecord["role"], content: string, inputMetadata?: MessageRecord["inputMetadata"]): MessageRecord => ({
  id,
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  role,
  content,
  ...(inputMetadata ? { inputMetadata } : {}),
  createdAt: new Date("2026-11-13T09:00:00.000Z"),
});

const pickOf = (itemKey: string) => ({
  method: "item_select" as const,
  selection: { messageId: "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5", blockId: "b1", itemKey },
});

const history = [
  message("m1", "user", "Which boat trips do you run in the evening?"),
  message("m2", "assistant", "Two boats sail at sunset."),
  message("m3", "user", "Giro del faro", pickOf("image-faro")),
  message("m4", "assistant", "The Lighthouse Loop takes two hours."),
];

const picked = { messageId: "m4", blockId: "b1", key: "image-tramonto", title: "Crociera al tramonto" };

describe("what a turn's response language is judged on", () => {
  it("judges a pick of an Italian-titled card on the English the visitor wrote, leaving earlier picks out", () => {
    const evidence = responseLanguageEvidence("Crociera al tramonto", { itemSelection: picked, history });

    expect(evidence.query).toBe("Which boat trips do you run in the evening?");
    expect(evidence.history.map(({ id }) => id)).toEqual(["m1", "m2", "m4"]);
  });

  it("judges a written message on its own words, still without the titles of earlier picks", () => {
    const evidence = responseLanguageEvidence("And on Sundays?", { history });

    expect(evidence.query).toBe("And on Sundays?");
    expect(evidence.history.map(({ id }) => id)).toEqual(["m1", "m2", "m4"]);
  });

  it("leaves the query empty for a pick when the visitor has written nothing yet, so the detector reads the conversation", () => {
    const opening = [message("g1", "assistant", "Hallo! Welche Tour interessiert Sie?")];

    expect(responseLanguageEvidence("Sunset cruise", { itemSelection: picked, history: opening })).toEqual({ query: "", history: opening });
  });
});
