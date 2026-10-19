import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import { SwitchedReply } from "../../src/modules/voiceChannel/services/switchedTurns.js";
import type { VoiceReplyEvent } from "../../src/modules/voiceChannel/services/voiceTurnPolicy.js";

const speech = (text: string, last = false): VoiceReplyEvent => ({ type: "speech", text, last });
const outcome: VoiceReplyEvent = { type: "outcome", outcome: { kind: "continue" } };

describe("a switched turn's reply, as its follow-up reads it", () => {
  it("ends the reading at the reply's outcome, even when the reader loses its caller before the reply has finished", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const reply = new SwitchedReply((async function* () {
      yield speech("Apriamo alle nove.", true);
      yield outcome;
      // The chat turn's bookkeeping after its outcome: the reply has not ended yet.
      await finished;
    })(), []);
    const stop = new AbortController();

    const read: VoiceReplyEvent[] = [];
    for await (const event of reply.read(stop.signal)) {
      read.push(event);
      if (event.type === "outcome") stop.abort();
    }
    finish();

    expect(read).toEqual([speech("Apriamo alle nove.", true), outcome]);
  });

  it("holds one abort listener on the reader's signal however many times it waits, and none once it ends", async () => {
    const reply = new SwitchedReply((async function* () {
      for (let index = 0; index < 30; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield speech(`Sentence ${index}. `);
      }
      yield outcome;
    })(), []);
    const stop = new AbortController();
    let mostListeners = 0;

    for await (const _event of reply.read(stop.signal)) {
      mostListeners = Math.max(mostListeners, getEventListeners(stop.signal, "abort").length);
    }

    expect(mostListeners).toBe(1);
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });
});
