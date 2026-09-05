/**
 * Reconstruction of the production "terse / senseless clarification" incident
 * (conversation 1d487267…, agent Claudio): two assistant turns rendered as a bare
 * sense label instead of a usable answer. Diagnosis: retrieval-sense clarification
 * fired on near-tied senses ("ask"), and the question generator collapsed to one
 * candidate label, hiding the alternatives.
 *
 * This eval drives the REAL decision evaluator and the REAL DefaultClarifier loaded
 * with the REAL production prompt, using the exact confidences and labels from the
 * production trace, to prove the two fixes hold end-to-end:
 *   #3 near-tied senses now answer-first ("offer") instead of blocking ("ask").
 *   #2 even if the model degenerates, the rendered question shows every option.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ClarificationCandidate,
  ClarificationPolicy,
  ConversationModelGateway,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultClarifier } from "@radioso/conversation-defaults";

import { evaluateRetrievalSenseClarification, type RetrievalSenseDetectorPort } from "../../src/modules/retrieval/services/retrievalSenseClarification.js";
import type { RetrievalSenseClarificationCandidate } from "../../src/modules/retrieval/services/senseGroupingService.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

// The production wiring (dependencyBuilders.ts). margin/floor/maxOptions are
// unchanged; askMargin is the value this change lowered from 0.03 to 0.01.
const PROD_FLOOR = 0;
const PROD_MARGIN = 0.15;
const PROD_MAX_OPTIONS = 4;
const NEW_ASK_MARGIN = 0.01;
const OLD_ASK_MARGIN = 0.03;

const policy = (askMargin: number): ClarificationPolicy => ({
  floor: PROD_FLOOR,
  margin: PROD_MARGIN,
  askMargin,
  maxOptions: PROD_MAX_OPTIONS,
});

const detectorReturning = (
  candidates: RetrievalSenseClarificationCandidate[],
): RetrievalSenseDetectorPort => ({
  detect: vi.fn(async () => candidates),
});

const sense = (id: string, label: string, confidence: number): RetrievalSenseClarificationCandidate => ({
  id,
  label,
  confidence,
  labelStatus: "generated",
  payload: { documentIds: [id] },
});

const evaluate = (input: { candidates: RetrievalSenseClarificationCandidate[]; askMargin: number; originalQuery: string }) =>
  evaluateRetrievalSenseClarification({
    detector: detectorReturning(input.candidates),
    workspaceId: "ws_1",
    rankedCandidates: [],
    conversationId: "conv_1",
    messageId: "msg_1",
    originalQuery: input.originalQuery,
    policy: policy(input.askMargin),
    suppressAsk: false,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

// The two real incident turns, with the confidences recorded in the trace.
const incidents = [
  {
    name: "Prove the spiritual plane exists and that I even need this.",
    candidates: [
      sense("doc_practical", "How a spiritual path becomes practical", 0.819111),
      sense("doc_meaning", "What spirituality means and how to approach it", 0.795053),
    ],
  },
  {
    name: "Why does God allow unbearable suffering (incl. animals)?",
    candidates: [
      sense("doc_coping", "Coping with suffering and karma", 0.866453),
      sense("doc_community", "About the Ananda community", 0.842162),
    ],
  },
];

describe("clarification terse-incident eval — #3 ask less eagerly", () => {
  for (const incident of incidents) {
    it(`blocks with the old margin but answers-first with the new one: ${incident.name}`, async () => {
      const before = await evaluate({ candidates: incident.candidates, askMargin: OLD_ASK_MARGIN, originalQuery: incident.name });
      const after = await evaluate({ candidates: incident.candidates, askMargin: NEW_ASK_MARGIN, originalQuery: incident.name });

      // Gap is ~0.024 in both incidents: under 0.03 (blocked) but over 0.01 (answer-first).
      expect(before?.kind).toBe("ask");
      expect(after?.kind).toBe("offer");
      // Answer-first scopes retrieval to the strongest sense and offers the other.
      if (after?.kind === "offer") {
        expect(after.documentScope).toEqual([incident.candidates[0].id]);
        expect(after.alternatives.map((candidate) => candidate.id)).toEqual([incident.candidates[1].id]);
      }
    });
  }
});

// The production prompt, loaded the same way the app loads it.
const productionQuestionPrompt = loadPromptTemplate("chat/clarification-question.md");

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Claudio" },
  sessionId: "conv_1",
  inputEvent: { id: "msg_1", kind: "message", content, locale: "en" },
  history: [],
  stagedContext: [],
  steering: [],
});

describe("clarification terse-incident eval — #2 question never collapses", () => {
  const candidates: ClarificationCandidate[] = [
    { id: "doc_practical", label: "How a spiritual path becomes practical", confidence: 0.819111, payload: { documentIds: ["doc_practical"] } },
    { id: "doc_meaning", label: "What spirituality means and how to approach it", confidence: 0.795053, payload: { documentIds: ["doc_meaning"] } },
  ];

  it("shows every option even when the model emits the exact bare label from the incident", async () => {
    // The model returns precisely what it persisted in production: one sense label.
    const clarifier = new DefaultClarifier(gateway("What spirituality means and how to approach it"), {
      questionPromptTemplate: productionQuestionPrompt,
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Prove the spiritual plane exists and that I even need this.") });

    // Both options are present and numbered — the failure (a lone label) cannot recur.
    expect(question).toContain("1. How a spiritual path becomes practical");
    expect(question).toContain("2. What spirituality means and how to approach it");
    // The model is never handed the option labels, so it cannot have been the source
    // of the numbered list — proving the options come from code, not the model.
    const systemPrompt = vi.mocked((clarifier as unknown as { modelGateway: ConversationModelGateway }).modelGateway.complete).mock.calls[0][0].systemPrompt;
    expect(systemPrompt).not.toContain("How a spiritual path becomes practical");
  });

  it("produces a clean question when the model phrases a proper lead-in", async () => {
    const clarifier = new DefaultClarifier(gateway("Which of these best matches what you're asking?"), {
      questionPromptTemplate: productionQuestionPrompt,
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Prove the spiritual plane exists and that I even need this.") });

    expect(question).toBe([
      "Which of these best matches what you're asking?",
      "",
      "1. How a spiritual path becomes practical",
      "2. What spirituality means and how to approach it",
    ].join("\n"));
  });
});
