import { describe, expect, it } from "vitest";

import { createSentenceCutter, splitCompleteSentences, wholeTextSpeech } from "../../src/modules/voiceChannel/services/speechSegmenter.js";

/** The spoken text of each piece a cutter released. */
const texts = (pieces: ReadonlyArray<{ text: string }>): string[] => pieces.map((piece) => piece.text);

describe("voice speech segmenter", () => {
  it("cuts a sentence once whitespace follows its terminator and keeps the punctuation", () => {
    expect(splitCompleteSentences("Hello there. How are")).toEqual({
      sentences: ["Hello there. "],
      remainder: "How are",
    });
  });

  it("holds a terminator back until whitespace proves the sentence ended", () => {
    expect(splitCompleteSentences("It costs 3.")).toEqual({ sentences: [], remainder: "It costs 3." });
    expect(splitCompleteSentences("It costs 3.50 a month")).toEqual({
      sentences: [],
      remainder: "It costs 3.50 a month",
    });
  });

  it("cuts every complete sentence in one buffer and keeps the text verbatim", () => {
    const buffer = "Yes! We open at nine.\nDo you want the address? Sure";
    const { sentences, remainder } = splitCompleteSentences(buffer);

    expect(sentences).toEqual(["Yes! ", "We open at nine.\n", "Do you want the address? "]);
    expect(remainder).toBe("Sure");
    expect([...sentences, remainder].join("")).toBe(buffer);
  });

  it("keeps closing quotes and brackets with the sentence they close", () => {
    expect(splitCompleteSentences("She said \"call us.\" Then")).toEqual({
      sentences: ["She said \"call us.\" "],
      remainder: "Then",
    });
  });

  it("treats runs of terminators and an ellipsis as one boundary", () => {
    expect(splitCompleteSentences("Really?! Wait… Fine")).toEqual({
      sentences: ["Really?! ", "Wait… "],
      remainder: "Fine",
    });
  });

  it("cuts after full-width terminators, which are not followed by spaces", () => {
    expect(splitCompleteSentences("はい。予約しますか？それとも")).toEqual({
      sentences: ["はい。", "予約しますか？"],
      remainder: "それとも",
    });
  });

  it("cuts Arabic and Devanagari sentence endings", () => {
    expect(splitCompleteSentences("مرحبا؟ كيف يمكنني المساعدة")).toEqual({
      sentences: ["مرحبا؟ "],
      remainder: "كيف يمكنني المساعدة",
    });
    expect(splitCompleteSentences("नमस्ते। आप कैसे")).toEqual({
      sentences: ["नमस्ते। "],
      remainder: "आप कैसे",
    });
  });

  it("returns the whole buffer as the remainder when no sentence is complete", () => {
    expect(splitCompleteSentences("")).toEqual({ sentences: [], remainder: "" });
    expect(splitCompleteSentences("Let me check")).toEqual({ sentences: [], remainder: "Let me check" });
  });

  describe("assertion markers", () => {
    it("removes the four marker forms the composer writes for citations", () => {
      expect(splitCompleteSentences(
        "Open at nine[[1]]. Closed Sundays[[?]]. Parking nearby[2]. Booking needed[?]. Next",
      )).toEqual({
        sentences: ["Open at nine. ", "Closed Sundays. ", "Parking nearby. ", "Booking needed. "],
        remainder: "Next",
      });
    });

    it("removes a run of markers and the whitespace before them", () => {
      expect(splitCompleteSentences("A good point[1][3]. Another [[2]][[?]]. Next")).toEqual({
        sentences: ["A good point. ", "Another. "],
        remainder: "Next",
      });
    });

    it("removes a marker inside a sentence without leaving a double space", () => {
      expect(splitCompleteSentences("The price [2] is fixed. Next")).toEqual({
        sentences: ["The price is fixed. "],
        remainder: "Next",
      });
    });

    it("speaks the live reply that leaked markers without them", () => {
      const reply = "I can't confirm the cost from this information.[?] If you mean the monthly plan, ask me about that instead.[?]";

      expect(splitCompleteSentences(reply)).toEqual({
        sentences: ["I can't confirm the cost from this information. "],
        remainder: "If you mean the monthly plan, ask me about that instead.",
      });
    });

    it("removes a marker that arrives split across chunks", () => {
      const first = splitCompleteSentences("From this information.[");
      const second = splitCompleteSentences(`${first.remainder}?] If you mean[[1`);
      const third = splitCompleteSentences(`${second.remainder}]] it.`);

      expect(first.sentences).toEqual([]);
      expect(second.sentences).toEqual(["From this information. "]);
      expect(third).toEqual({ sentences: [], remainder: "If you mean it." });
    });

    it("leaves nothing to speak when a buffer was only markers", () => {
      expect(splitCompleteSentences("[1][[?]]")).toEqual({ sentences: [], remainder: "" });
    });

    it("keeps other bracketed text", () => {
      expect(splitCompleteSentences("Room [B] is free [today]. Next")).toEqual({
        sentences: ["Room [B] is free [today]. "],
        remainder: "Next",
      });
    });
  });

  describe("markdown", () => {
    it("speaks the live reply's bold phrase without its markers", () => {
      expect(splitCompleteSentences("Sì, puoi usare la **versione open-source** gratuitamente")).toEqual({
        sentences: [],
        remainder: "Sì, puoi usare la versione open-source gratuitamente",
      });
    });

    it("speaks a bulleted and a numbered list as plain lines", () => {
      const reply = "## Opzioni\nEcco cosa puoi fare:\n- **Cloud**: lo gestiamo noi.\n* _Self-hosted_: è gratis.\n1. Scarica il pacchetto.\n2) Avvialo. Fine";

      expect(splitCompleteSentences(reply)).toEqual({
        sentences: [
          "Opzioni\nEcco cosa puoi fare:\nCloud: lo gestiamo noi.\n",
          "Self-hosted: è gratis.\n",
          "Scarica il pacchetto.\n",
          "Avvialo. ",
        ],
        remainder: "Fine",
      });
    });

    it("speaks a link's text, an image's alt text and inline code without their syntax", () => {
      expect(splitCompleteSentences(
        "Leggi [la guida](https://radioso.ai/docs/voice_(beta)) e ![il logo](logo.png). Poi esegui `pnpm install` qui. Next",
      )).toEqual({
        sentences: ["Leggi la guida e il logo. ", "Poi esegui pnpm install qui. "],
        remainder: "Next",
      });
    });

    it("removes single-character emphasis next to punctuation and quotes", () => {
      expect(splitCompleteSentences("È *davvero* semplice, (*quasi*) gratis e l'*agente* risponde. Next")).toEqual({
        sentences: ["È davvero semplice, (quasi) gratis e l'agente risponde. "],
        remainder: "Next",
      });
    });

    it("keeps hyphens, apostrophes, decimals, ellipses, arithmetic and identifiers", () => {
      const text = "L'open-source costa 3.50 euro… o 2 * 3 euro, vedi my_setting e 5*3. Aspetta... Next";

      expect(splitCompleteSentences(text)).toEqual({
        sentences: ["L'open-source costa 3.50 euro… ", "o 2 * 3 euro, vedi my_setting e 5*3. ", "Aspetta... "],
        remainder: "Next",
      });
    });

    it("removes bold markers that arrive split across chunks", () => {
      const first = splitCompleteSentences("Usa la *");
      const second = splitCompleteSentences(`${first.remainder}*versione open-source*`);
      const third = splitCompleteSentences(`${second.remainder}* gratis. Next`);

      expect(first).toEqual({ sentences: [], remainder: "Usa la *" });
      expect(second.sentences).toEqual([]);
      expect(third).toEqual({ sentences: ["Usa la versione open-source gratis. "], remainder: "Next" });
    });

    it("keeps a `*` or `_` that a chunk boundary separates from the text after it", () => {
      const price = createSentenceCutter();
      expect(texts(price.push("Costa 5*"))).toEqual([]);
      expect(texts(price.push("3 euro. Next"))).toEqual(["Costa 5*3 euro. "]);

      const setting = createSentenceCutter();
      expect(texts(setting.push("Vedi my_"))).toEqual([]);
      expect(texts(setting.push("setting. Next"))).toEqual(["Vedi my_setting. "]);
    });

    it("removes a list marker only at a real line start, not at the start of a chunk's leftover", () => {
      const prose = createSentenceCutter();
      expect(texts(prose.push("Ok. 2"))).toEqual(["Ok. "]);
      expect(texts(prose.push(". Poi"))).toEqual(["2. "]);
      expect(prose.finish()).toEqual({ sentences: [], remainder: { text: "Poi", writtenEnd: 10 } });

      const list = createSentenceCutter();
      expect(texts(list.push("Fatto.\n2"))).toEqual(["Fatto.\n"]);
      expect(texts(list.push(". Poi"))).toEqual([]);
      expect(list.finish()).toEqual({ sentences: [], remainder: { text: "Poi", writtenEnd: 13 } });
    });

    it("closes emphasis at the end of the reply only once the reply is whole", () => {
      const reply = createSentenceCutter();
      expect(texts(reply.push("È tutto. Fine *davvero*"))).toEqual(["È tutto. "]);
      expect(reply.finish()).toEqual({ sentences: [], remainder: { text: "Fine davvero", writtenEnd: 23 } });
      expect(splitCompleteSentences("Fine *davvero*")).toEqual({ sentences: [], remainder: "Fine davvero*" });
      expect(splitCompleteSentences("Fine *davvero*", { startsLine: true, final: true }).remainder).toBe("Fine davvero");
    });
  });
});

describe("a whole text as speech", () => {
  it("cuts it into sentences that each end in whitespace, with its markdown removed", () => {
    expect(wholeTextSpeech("Yes, **four** works. Bring your [card](https://example.com/card), please")).toEqual([
      "Yes, four works. ",
      "Bring your card, please\n",
    ]);
    expect(wholeTextSpeech("- Bring your card.")).toEqual(["Bring your card.\n"]);
  });

  it("speaks nothing for a text with no words to say", () => {
    expect(wholeTextSpeech("  ")).toEqual([]);
    expect(wholeTextSpeech("**")).toEqual([]);
  });
});

describe("where each sentence a streamed reply releases ends in its written text", () => {
  /** Streams `chunks` through the cutter and keeps the written start of its first `pieceCount` sentences, as a turn cut off after them would. */
  const writtenStart = (chunks: string[], pieceCount: number): string => {
    const cutter = createSentenceCutter();
    const pieces = chunks.flatMap((chunk) => cutter.push(chunk));
    return chunks.join("").slice(0, pieces[pieceCount - 1]?.writtenEnd ?? 0);
  };

  it("is the text up to the end of the last sentence released, as the composer wrote it", () => {
    expect(writtenStart(["We open at nine. Satur", "days at ten. Sundays we"], 2)).toBe("We open at nine. Saturdays at ten. ");
    expect(writtenStart(["We open at nine. Saturdays at ten. Sundays we"], 1)).toBe("We open at nine. ");
  });

  it("keeps the markdown of the sentences released, closing delimiters and links included, and none that opens the next", () => {
    expect(writtenStart(["We open at **ni", "ne** on weekdays. See [the hours](https://example.com/h). Then"], 2))
      .toBe("We open at **nine** on weekdays. See [the hours](https://example.com/h). ");
    expect(writtenStart(["Our plans:\n- Basic is free.\n- Pro is ten euros.\n- Te", "am"], 2))
      .toBe("Our plans:\n- Basic is free.\n- Pro is ten euros.\n");
    expect(writtenStart(["Our plans:\n- Basic is free.\n- Pro is ten euros.\n- Team"], 1)).toBe("Our plans:\n- Basic is free.\n");
    expect(writtenStart(["Done. **Bold** next."], 1)).toBe("Done. ");
  });

  it("keeps the citation markers of the sentences released, wherever the composer put them", () => {
    expect(writtenStart(["We open at nine [[1]]. Saturdays at ten.[[2]", "] Sundays we"], 2)).toBe("We open at nine [[1]]. Saturdays at ten.[[2]] ");
    expect(writtenStart(["We open at nine.[1] Saturdays"], 1)).toBe("We open at nine.[1] ");
  });

  it("ends inside a link whose text holds a sentence end, which the store repairs", () => {
    expect(writtenStart(["[See the hours. Then](https://example.com/h) we close."], 1)).toBe("[See the hours. ");
  });

  it("is the whole sentence for a script that writes no space after it", () => {
    expect(writtenStart(["私たちは九時に開きます。土曜日は"], 1)).toBe("私たちは九時に開きます。");
  });
});
