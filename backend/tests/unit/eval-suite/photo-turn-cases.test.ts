import { describe, expect, it, vi } from "vitest";

import { runConversationQualitySuite, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { loadPromptTemplate } from "../../../src/shared/infra/prompts/promptLoader.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/index.js";
import { ARTS_WEEKEND_DOC_ID, MOUNTAIN_COURSE_DOC_ID } from "../../fixtures/conversation-quality/corpus.js";
import { canonicalAnswerEnvelope, conversationQualityChatHarness } from "../../support/conversationQualityChatHarness.js";

// The `photo-turn` cases carry the photo's description in the visitor's message, as the chat
// door renders it. Their live half is judged; this drives the unmatched-photo case's
// deterministic gate through the chat pipeline with scripted replies.
describe("photo-turn cases through the chat pipeline", () => {
  const unmatchedCase = conversationQualityCases.find((evalCase) => evalCase.id === "photo-turn-unmatched-photo-says-what-it-saw")!;
  const pipelineCase: ConversationQualityCase = {
    ...unmatchedCase,
    assertions: unmatchedCase.assertions.filter((assertion) => assertion.type !== "llm_judge"),
  };
  const runCase = async (reply: string) => {
    const harness = conversationQualityChatHarness({ reply, retrievedDocumentIds: [ARTS_WEEKEND_DOC_ID, MOUNTAIN_COURSE_DOC_ID] });
    const { reports } = await runConversationQualitySuite([pipelineCase], harness.port, { workspaceId: "ws" });
    const answerCall = vi.mocked(harness.chatGateway.answer).mock.calls
      .map(([input]) => input)
      .find((input) => input.systemPrompt?.includes("Output envelope"));
    return { report: reports[0], answerCall };
  };

  it("runs on the photo's description, and gives the answer model the attached-photo rules", async () => {
    const { answerCall } = await runCase(canonicalAnswerEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "courses like a pixel-art pyramid",
      outcome: "no_support",
      answer: "That's a pixel-art stepped pyramid under a night sky. What draws you to it: the theme, the place, or a style of practice?",
      claims: [],
      grounding: "degraded",
    }));

    expect(unmatchedCase.query).toMatch(/^are there any similar courses\?\n<attached_photo index="1">Pixel-art illustration of a stepped stone pyramid/);
    expect(answerCall?.systemPrompt).toContain(loadPromptTemplate("chat/attached-photos.md"));
  });

  it("fails a bare decline that never says what the photo showed and goes straight to the contacts", async () => {
    const { report } = await runCase(canonicalAnswerEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "courses similar to the photo",
      outcome: "no_support",
      answer: "I can't confirm any similar course from what's shown here. If you want, contact us at corsi@example.org or 0123 456 789.",
      claims: [],
      grounding: "degraded",
    }));

    expect(report?.status).toBe("fail");
  });

  it("passes a reply that says what the photo shows and offers the closest course as the closest", async () => {
    const { report } = await runCase(canonicalAnswerEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "courses like a pixel-art pyramid",
      outcome: "answer",
      answer: "That's a pixel-art stepped pyramid under a night sky, and none of our courses is on that theme. The closest we have is the creative-arts weekend, with music, dance and painting[[1]].",
      claims: [[1]],
      grounding: "degraded",
    }));

    if (report?.status !== "pass") {
      throw new Error(`expected pass, got ${report?.status}: ${JSON.stringify(report?.verdicts, null, 2)}`);
    }
  });
});
