import { describe, expect, it } from "vitest";

import {
  stripPublicChatCitationArtifacts,
  stripPublicStreamCitationArtifacts,
} from "../../src/app/http/presenters/publicChatPresenter.js";
import type { ChatStreamEvent } from "../../src/modules/chat/contracts/index.js";

const collect = async (events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
  const collected: ChatStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

describe("public chat presenter", () => {
  it("strips citation anchors from in-progress public stream chunks", async () => {
    const events = await collect(stripPublicStreamCitationArtifacts((async function* () {
      yield { type: "chunk", text: "Preparation period[[" };
      yield { type: "chunk", text: "9]]. Next " };
      yield { type: "chunk", text: "claim[[10]]." };
    })(), false));

    expect(events).toEqual([
      { type: "chunk", text: "Preparation period" },
      { type: "chunk", text: ". Next" },
      { type: "chunk", text: " claim." },
    ]);
    expect(events.map((event) => event.type === "chunk" ? event.text : "").join("")).toBe(
      "Preparation period. Next claim.",
    );
  });

  const payload = () => ({
    answer: "Grounded answer.",
    citations: [
      { documentId: "doc-1", chunkId: "chunk-1", title: "Policy Handbook", sourceUrl: "https://example.com/policy" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Internal Memo" },
    ],
    answerSegments: [{ text: "Grounded answer.", citationIndices: [0, 1] }],
  });

  it("hides citations entirely when citation display is disabled", () => {
    const result = stripPublicChatCitationArtifacts(payload(), false) as Record<string, unknown>;

    expect(result.citations).toBeUndefined();
    expect(result.answerSegments).toEqual([{ text: "Grounded answer." }]);
  });

  it("exposes labels and links but never internal identifiers when citation display is enabled", () => {
    const result = stripPublicChatCitationArtifacts(payload(), true) as Record<string, unknown>;

    expect(result.citations).toEqual([
      { documentId: "", chunkId: "", title: "Policy Handbook", sourceUrl: "https://example.com/policy" },
      { documentId: "", chunkId: "", title: "Internal Memo" },
    ]);
    // Segment indices survive so the client can render non-interactive markers.
    expect(result.answerSegments).toEqual([{ text: "Grounded answer.", citationIndices: [0, 1] }]);
  });
});
