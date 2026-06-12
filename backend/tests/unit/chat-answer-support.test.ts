import { describe, expect, it } from "vitest";

import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (): PreparedSession =>
  ({
    agent: { workspaceId: "workspace-1" },
    conversation: { id: "conversation-1" },
    userMessage: { id: "message-1" },
    responseLanguage: "English",
    retrieval: {
      responseIdentity: { name: "Radioso" },
      responseSettings: {
        customInstruction: "Keep answers grounded.",
        responseLanguagePolicy: "match_user_question",
      },
      diagnostics: {
        rewriteProposal: {
          responseLanguage: "Italian",
        },
      },
    },
  }) as unknown as PreparedSession;

describe("ChatAnswerSupport", () => {
  it("uses the shared per-turn response language instead of rewrite language", () => {
    const result = new ChatAnswerSupport().buildAnswerInstructionBlock(session());

    expect(result).toContain("Respond in English.");
    expect(result).not.toContain("Respond in Italian.");
  });
});
