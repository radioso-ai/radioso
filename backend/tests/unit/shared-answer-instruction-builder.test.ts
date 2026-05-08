import { describe, expect, it } from "vitest";

import { SharedAnswerInstructionBuilder } from "../../src/modules/retrieval/services/sharedAnswerInstructionBuilder.js";

describe("shared answer instruction builder", () => {
  it("builds combined instructions for non-retrieval prompts", () => {
    const builder = new SharedAnswerInstructionBuilder();

    const result = builder.buildCombinedBlock({
      responseIdentity: {
        name: "Vikram",
      },
      customInstruction: "Keep the tone calm.",
      conversationMode: "guided",
      responseLanguagePolicy: "match_user_question",
    });

    expect(result).toContain("Stable response identity:");
    expect(result).toContain("Vikram");
    expect(result).toContain("Configured response instructions:");
    expect(result).toContain("Keep the tone calm.");
    expect(result).toContain("Conversation mode: guided.");
    expect(result).toContain("Respond in the same language as the current user question.");
  });

  it("omits empty custom instruction content", () => {
    const builder = new SharedAnswerInstructionBuilder();

    const result = builder.buildCombinedBlock({
      customInstruction: " \n\t ",
      conversationMode: "guided",
      responseLanguagePolicy: "match_user_question",
    });

    expect(result).not.toContain("Configured response instructions:");
    expect(result).toContain("Conversation mode: guided.");
  });

  it("omits conversation-mode guidance when retrieval is used without response behavior", () => {
    const builder = new SharedAnswerInstructionBuilder();

    const result = builder.buildCombinedBlock({
      responseLanguagePolicy: "match_user_question",
    });

    expect(result).not.toContain("Stable response identity:");
    expect(result).not.toContain("Configured response instructions:");
    expect(result).not.toContain("Conversation mode:");
  });
});
