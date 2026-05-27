import { describe, expect, it } from "vitest";

import { stripPublicStreamCitationArtifacts } from "../../src/app/http/presenters/publicChatPresenter.js";
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
    })()));

    expect(events).toEqual([
      { type: "chunk", text: "Preparation period" },
      { type: "chunk", text: ". Next" },
      { type: "chunk", text: " claim." },
    ]);
    expect(events.map((event) => event.type === "chunk" ? event.text : "").join("")).toBe(
      "Preparation period. Next claim.",
    );
  });
});
