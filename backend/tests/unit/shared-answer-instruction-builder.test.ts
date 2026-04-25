import { describe, expect, it } from "vitest";

import { SharedAnswerInstructionBuilder } from "../../src/modules/retrieval/services/sharedAnswerInstructionBuilder.js";

describe("shared answer instruction builder", () => {
  it("builds combined instructions for non-retrieval prompts", () => {
    const builder = new SharedAnswerInstructionBuilder();

    const result = builder.buildCombinedBlock({
      assistantIdentity: {
        assistantName: "Vikram",
        assistantRole: "Guide to self-realization",
        greetingInstruction: "",
      },
      customInstruction: "Keep the tone calm.",
      conversationMode: "guided",
      responseLanguagePolicy: "match_user_question",
    });

    expect(result).toContain("Stable assistant identity:");
    expect(result).toContain("Vikram");
    expect(result).toContain("Workspace-specific instructions:");
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

    expect(result).not.toContain("Workspace-specific instructions:");
    expect(result).toContain("Conversation mode: guided.");
  });
});
