import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../../src/modules/chat/contracts/chatGateway.js";
import { AnswerLinkGuard } from "../../../src/modules/chat/services/answerLinkGuard.js";
import { AssistantSuggestionExpansionService } from "../../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalAnswerComposer } from "../../../src/modules/chat/services/retrievalTurnSkill.js";
import { StreamedAnswerText } from "../../../src/modules/chat/services/streamedAnswerText.js";
import type { RetrievalPipelineResult } from "../../../src/modules/retrieval/public.js";

const COURSE_URL = "https://school.example/courses/breath";
const CONTACT_URL = "https://school.example/contact";
const SYSTEM_PROMPT = `Speak for the school. Send visitors with questions to ${CONTACT_URL}.`;
const PROMPT = [
  `Result 1 (Il respiro consapevole): Source: ${COURSE_URL}`,
  "Three days of breath work, 260 euro. Write to info@school.example.",
  "",
  "Result 2 (Il silenzio del cuore): A silent retreat in October.",
].join("\n");

const HISTORY_URL = "https://school.example/autumn/programme/il-silenzio-del-cuore-ritiro-di-tre-giorni";

/** What one gateway call sends: only these fields reach the guard. */
const gatewayInput = (fields: Pick<ChatGatewayInput, "systemPrompt" | "prompt" | "history">): ChatGatewayInput =>
  ({ query: "Which courses?", usageContext: {}, ...fields }) as unknown as ChatGatewayInput;

const guard = new AnswerLinkGuard();
guard.sendsAnswer(gatewayInput({ systemPrompt: SYSTEM_PROMPT, prompt: PROMPT, history: [] }));

describe("AnswerLinkGuard", () => {
  it("keeps links to addresses the prompt gave and unwraps the rest", () => {
    const { presented, unwrapped } = guard.present({
      answer: `Join [Il respiro consapevole](${COURSE_URL}); [Il silenzio](#) is not listed. `
        + `Ask via [our contact page](${CONTACT_URL}) or [mail](mailto:info@school.example), not `
        + "[Plans and Pricing](Plans and Pricing) or [the site](https://example.org).",
    });

    expect(presented.answer).toBe(
      `Join [Il respiro consapevole](${COURSE_URL}); Il silenzio is not listed. `
        + `Ask via [our contact page](${CONTACT_URL}) or [mail](mailto:info@school.example), not `
        + "Plans and Pricing or the site.",
    );
    expect(unwrapped).toEqual(["fragment", "malformed", "not_given"]);
  });

  it("keeps a link to an address only the conversation history holds, and still unwraps an invented one", () => {
    const withHistory = new AnswerLinkGuard();
    const history = [
      { role: "user", content: "Which retreats run in October?" },
      { role: "assistant", content: `${"Our autumn retreats fill quickly. ".repeat(10)}See [Il silenzio del cuore](${HISTORY_URL}).` },
    ] as unknown as ChatGatewayInput["history"];
    const input = gatewayInput({ systemPrompt: SYSTEM_PROMPT, prompt: PROMPT, history });

    expect(withHistory.sendsAnswer(input)).toBe(input);
    expect(withHistory.present({
      answer: `Here it is again: [Il silenzio del cuore](${HISTORY_URL}), or [the booking page](https://school.example/booking).`,
    }).presented.answer).toBe(`Here it is again: [Il silenzio del cuore](${HISTORY_URL}), or the booking page.`);
  });

  it("allows what a focused decline was sent, and nothing before anything was sent", () => {
    const declineOnly = new AnswerLinkGuard();
    const answer = `Write to us through [our contact page](${CONTACT_URL}).`;

    expect(declineOnly.present({ answer }).presented.answer).toBe("Write to us through our contact page.");
    declineOnly.sendsDecline({
      query: "Is there a silence course?",
      answerInstructionBlock: `Questions go through ${CONTACT_URL}.`,
      usageContext: {} as never,
    });
    expect(declineOnly.present({ answer }).presented.answer).toBe(answer);
  });

  it("guards each segment as it is rendered, and keeps their citations", () => {
    const { presented } = guard.present({
      answer: "Join [Breath](#) in November. Ask [us](https://example.org).",
      answerSegments: [
        { text: "Join [Breath](#) in November", citationIndices: [0] },
        { text: ". Ask [us](https://example.org)." },
      ],
    });

    expect(presented.answer).toBe("Join Breath in November. Ask us.");
    expect(presented.answerSegments).toEqual([
      { text: "Join Breath in November", citationIndices: [0] },
      { text: ". Ask us." },
    ]);
  });

  it("makes one segment of segments that no longer join to the guarded answer", () => {
    const { presented } = guard.present({
      answer: "Join [Breath](#) now.",
      answerSegments: [{ text: "Join [Breath", citationIndices: [0] }, { text: "](#) now.", citationIndices: [1] }],
    });

    expect(presented.answerSegments).toEqual([{ text: "Join Breath now.", citationIndices: [0, 1] }]);
  });
});

// The stream and the finished answer read the same text through the same grammar, so what a
// visitor watched stream in is what the stored message, `done`, the API, and email show.
describe("streamed and finished answer links", () => {
  const session = (): PreparedSession => ({
    agent: { workspaceId: "workspace-1", chatModelOverride: null } as never,
    conversation: { id: "conversation-1", workspaceId: "workspace-1" } as never,
    history: [],
    userMessage: { id: "message-1", content: "Which courses run this autumn?" } as never,
    turnRoute: "retrieval",
    pageContext: null,
    resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
    directiveSteering: { rules: [], matches: [], omissions: [] },
    retrieval: {
      systemPrompt: SYSTEM_PROMPT,
      prompt: PROMPT,
      responseIdentity: null,
      // Live release, so every chunk the model writes is compared, not a gated block.
      responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0, citationHoldEnabled: false },
      diagnostics: {},
      contexts: [1, 2].map((index) => ({
        documentId: `doc-${index}`,
        chunkId: `chunk-${index}`,
        title: `Course ${index}`,
        content: `Course evidence ${index}`,
      })),
    } as unknown as RetrievalPipelineResult,
  }) as unknown as PreparedSession;

  const envelope = (answer: string): string => JSON.stringify({
    coverage: "answered_sufficient_evidence",
    requestFocus: "the autumn courses",
    outcome: "answer",
    answer,
    v: 2,
    claims: [[1]],
    suggestions: [],
    grounding: "grounded",
  });

  const run = async (answer: string, chunkSizes: () => number) => {
    const raw = envelope(answer);
    const gateway: ChatGateway = {
      async answer() {
        return raw;
      },
      async *streamAnswer() {
        for (let offset = 0; offset < raw.length;) {
          const size = chunkSizes();
          yield raw.slice(offset, offset + size);
          offset += size;
        }
      },
    };
    const fallback: FallbackReplyComposer = {
      async composeNoContext() {
        return { text: "unused", declineReason: "content_gap" };
      },
    };
    const presenter = new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
      supportsGroundedAnswer: () => true,
    });
    const composer = new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter, fallback);
    const chunks: string[] = [];
    const stream = composer.streamAnswer(session(), "Which courses?", undefined, undefined);
    let step = await stream.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await stream.next();
    }
    return { streamed: chunks.join(""), finished: step.value.finalPresentation.answer };
  };

  // Deterministic, so a failing input reproduces.
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  const DESTINATIONS = [
    COURSE_URL,
    `${COURSE_URL} "Breath"`,
    CONTACT_URL,
    "mailto:info@school.example",
    "https://invented.example/silence",
    "https://example.org",
    "#",
    "Plans and Pricing",
    "/courses",
  ];
  const MARKERS = ["[[1]]", "[[2]]", "[[?]]", "[?]", "[[1]][[2]]"];
  const WORDS = ["Join", "the", "Breath", "course", "260", "€", "now", "or"];
  const OTHER = [".", ",", ";", "!", "`[x](#)`", "[note]", "(aside)", "arr[0]", "]", "[", "("];

  const randomAnswer = (random: () => number): string => {
    const pick = <Item>(items: readonly Item[]): Item => items[Math.floor(random() * items.length)];
    const link = () => {
      const marker = () => (random() < 0.3 ? pick(MARKERS) : "");
      const label = `${pick(["Breath", "Il silenzio", "our contact page"])}${random() < 0.3 ? ` ${pick(MARKERS)}` : ""}`;
      return `${random() < 0.1 ? "!" : ""}[${label}]${marker()}(${pick(DESTINATIONS)})${marker()}`;
    };
    // A marker is attached to the text before it, as the Citations rule asks. A space before a
    // marker the stream and the presentation remove differently, links or none.
    const token = () => {
      const roll = random();
      return roll < 0.35
        ? `${random() < 0.6 ? " " : ""}${link()}`
        : roll < 0.55
          ? pick(MARKERS)
          : `${random() < 0.6 ? " " : ""}${roll < 0.7 ? pick(OTHER) : pick(WORDS)}`;
    };
    const tokens = Array.from({ length: 2 + Math.floor(random() * 10) }, token);
    return `${pick(WORDS)}${tokens.join("")}.`;
  };

  it("shows a link whose marker sits between its text and its address as text in both", async () => {
    const answer = "Join [Breath][[1]](https://invented.example) now[[2]].";

    expect(await run(answer, () => 3)).toEqual({ streamed: "Join Breath now.", finished: "Join Breath now." });
  });

  it("streams exactly the finished answer's text for random answers and chunkings", async () => {
    const random = seeded(1751);
    const mismatches: Array<{ answer: string; streamed: string; finished: string }> = [];
    for (let sample = 0; sample < 3000; sample += 1) {
      const answer = randomAnswer(random);
      const { streamed, finished } = await run(answer, () => 1 + Math.floor(random() * 12));
      if (streamed !== finished) {
        mismatches.push({ answer, streamed, finished });
      }
    }

    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("never streams a link the finished answer does not show", () => {
    const text = new StreamedAnswerText(guard.stream());
    const released = ["Ask about [Il sil", "enzio](https://exa", "mple.org/silence) today."].map((chunk) => text.push(chunk));

    expect([...released, text.flush()]).toEqual(["Ask about ", "", "Il silenzio today.", ""]);
  });
});
