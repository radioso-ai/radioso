import { describe, expect, it } from "vitest";

import { heardSpeechOf } from "../../src/modules/voiceChannel/services/heardSpeech.js";

const answer = ["We open at nine on weekdays. ", "Saturdays at ten. "];

describe("what a caller heard of a turn's speech", () => {
  it("counts everything that reached the runtime as heard when it reports nothing", () => {
    expect(heardSpeechOf({ operatorReplies: [], bridge: null, answer })).toEqual({
      operatorReplyPieces: 0,
      answerPieces: 2,
      answerHeardCharacterCount: 46,
      answerSpokenCharacterCount: 46,
    });
  });

  it("counts the pieces heard to their end, and the characters heard into the piece the cut landed in", () => {
    expect(heardSpeechOf({ operatorReplies: [], bridge: null, answer }, "We open at nine on weekdays.  \u200BSaturdays at")).toEqual({
      operatorReplyPieces: 0,
      answerPieces: 1,
      answerHeardCharacterCount: 41,
      answerSpokenCharacterCount: 46,
    });
  });

  it("counts a report that leaves out only punctuation as heard whole", () => {
    expect(heardSpeechOf({ operatorReplies: [], bridge: null, answer }, "We open at nine on weekdays. Saturdays at ten")?.answerPieces).toBe(2);
  });

  it("measures a teammate's replies and a bridge line ahead of the answer, one space apart", () => {
    const operatorReplies = ["Yes, four works.\n", "Bring your card, please. ", "See you then\n"];
    expect(heardSpeechOf({ operatorReplies, bridge: null, answer }, "Yes, four works.\n Bring your card")).toMatchObject({
      operatorReplyPieces: 1,
      answerPieces: 0,
      answerHeardCharacterCount: 0,
    });
    expect(heardSpeechOf({ operatorReplies: [], bridge: "Let me check that for you.", answer }, "Let me check that for you. We open at nine on weekdays.")).toMatchObject({
      answerPieces: 1,
      answerHeardCharacterCount: 28,
    });
  });

  it("says nothing of speech the report is no prefix of", () => {
    expect(heardSpeechOf({ operatorReplies: [], bridge: null, answer }, "We close at")).toBeNull();
  });
});
