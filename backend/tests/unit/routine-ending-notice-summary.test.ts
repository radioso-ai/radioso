import { describe, expect, it, vi } from "vitest";

import { ModelRoutineEndingNoticeSummaryGenerator } from "../../src/modules/chat/services/actions/routineEndingNoticeSummary.js";

describe("ModelRoutineEndingNoticeSummaryGenerator", () => {
  it("gives the model bounded transcript context and collected values as exclusions", async () => {
    const complete = vi.fn(async (_input: { prompt: string }) => ({ text: "Late arrival requested." }));
    const generator = new ModelRoutineEndingNoticeSummaryGenerator({
      findByIdAndWorkspaceId: async () => ({ id: "ending", conversationId: "conv", workspaceId: "ws", role: "user", content: "We will arrive after 10pm.", createdAt: new Date() }),
      listBeforeByConversationId: async () => [{ id: "before", conversationId: "conv", workspaceId: "ws", role: "assistant", content: "What date?", createdAt: new Date() }],
    }, { complete } as never);

    await generator.generate({
      workspaceId: "ws", accountId: null, conversationId: "conv", endingMessageId: "ending",
      outputLanguage: "English", collected: { arrival_date: "2026-10-12" },
    });

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("arrival_date: 2026-10-12") }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("Do not repeat, paraphrase, or infer any collected value") }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("Output language: English") }));
  });
});
