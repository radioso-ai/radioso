import { describe, expect, it, vi } from "vitest";
import { decideClarification } from "@radioso/conversation-engine";

import {
  ModelSenseLabelGateway,
  SenseGroupingService,
  type RetrievalSenseClarificationCandidate,
  type SenseLabelGateway,
  type SenseLabelGroup,
} from "../../src/modules/retrieval/services/senseGroupingService.js";
import {
  evaluateRetrievalSenseClarification,
  phraseRetrievalSenseAsk,
  presentableSenseCandidates,
} from "../../src/modules/retrieval/services/retrievalSenseClarification.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/public.js";
import {
  dominantHathaYogaCandidates,
  hathaRajaYogaCandidates,
} from "../fixtures/retrievalSenseCorpus.js";

const policy = {
  minGroupShare: 0.3,
  separationThreshold: 0.4,
  maxOptions: 4,
};

type LabelInput = {
  question: string;
  groups: SenseLabelGroup[];
  conversationLanguage?: string;
  usageContext?: Parameters<SenseLabelGateway["label"]>[0]["usageContext"];
};

type LabelOutput = ReturnType<SenseLabelGateway["label"]>;

const candidate = (input: {
  chunkId: string;
  documentId: string;
  title: string;
  similarity: number;
}): RetrievedCandidate => ({
  chunkId: input.chunkId,
  documentId: input.documentId,
  title: input.title,
  content: `Fixture content for ${input.title}`,
  similarity: input.similarity,
  retrievalSources: ["semantic_rewritten"],
  retrievalText: `${input.title} fixture retrieval text`,
  semanticScore: input.similarity,
  lexicalScore: 0,
  attributeMatchScore: 0,
  metadata: {},
});

const sameShapeCandidates = (input: {
  leftTitle: string;
  leftSimilarities: [number, number];
  rightTitle: string;
  rightSimilarities: [number, number];
}): RetrievedCandidate[] => [
  candidate({
    chunkId: "left-1",
    documentId: "doc-left",
    title: input.leftTitle,
    similarity: input.leftSimilarities[0],
  }),
  candidate({
    chunkId: "right-1",
    documentId: "doc-right",
    title: input.rightTitle,
    similarity: input.rightSimilarities[0],
  }),
  candidate({
    chunkId: "left-2",
    documentId: "doc-left",
    title: input.leftTitle,
    similarity: input.leftSimilarities[1],
  }),
  candidate({
    chunkId: "right-2",
    documentId: "doc-right",
    title: input.rightTitle,
    similarity: input.rightSimilarities[1],
  }),
];

const separatedEmbeddings = () => new Map([
  ["left-1", [1, 0]],
  ["left-2", [1, 0.1]],
  ["right-1", [0, 1]],
  ["right-2", [0.1, 1]],
]);

describe("SenseGroupingService", () => {
  it("returns labeled clarification candidates for structurally qualified separated document groups", async () => {
    const embeddingReader = {
      readChunkEmbeddings: vi.fn(async () => new Map([
        ["hatha-1", [1, 0]],
        ["hatha-2", [1, 0.1]],
        ["raja-1", [0, 1]],
        ["raja-2", [0.1, 1]],
      ])),
    };
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async () => [
        { id: "doc-hatha", label: "Hatha yoga", description: "Physical postures and breath" },
        { id: "doc-raja", label: "Raja yoga", description: "Meditation and mental discipline" },
      ]),
    };
    const service = new SenseGroupingService({ embeddingReader, labelGateway, policy });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about yoga practice.",
      rankedCandidates: hathaRajaYogaCandidates().slice(0, 4),
      conversationLanguage: "en",
      usageContext: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "clarification",
        attemptKey: "turn-1",
      },
    });

    expect(embeddingReader.readChunkEmbeddings).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      chunkIds: ["hatha-1", "hatha-2", "raja-1", "raja-2"],
    });
    expect(labelGateway.label).toHaveBeenCalledWith(expect.objectContaining({
      question: "Tell me about yoga practice.",
      conversationLanguage: "en",
      groups: [
        expect.objectContaining({
          id: "doc-hatha",
          documentIds: ["doc-hatha"],
          documents: [expect.objectContaining({
            title: "Hatha Yoga Foundations",
            metadata: expect.objectContaining({ subject: "Hatha yoga" }),
          })],
        }),
        expect.objectContaining({
          id: "doc-raja",
          documentIds: ["doc-raja"],
          documents: [expect.objectContaining({
            title: "Raja Yoga Meditation",
            metadata: expect.objectContaining({ subject: "Raja yoga" }),
          })],
        }),
      ],
    }));
    expect(JSON.stringify(labelGateway.label.mock.calls[0]?.[0])).not.toContain("Fixture content");
    expect(candidates).toEqual([
      expect.objectContaining({
        id: "doc-hatha",
        label: "Hatha yoga",
        description: "Physical postures and breath",
        confidence: expect.any(Number),
        payload: { documentIds: ["doc-hatha"] },
      }),
      expect.objectContaining({
        id: "doc-raja",
        label: "Raja yoga",
        payload: { documentIds: ["doc-raja"] },
      }),
    ]);
  });

  it("renders the visitor question into the model sense-label prompt", async () => {
    const completions: Array<{ prompt: string }> = [];
    const gateway = new ModelSenseLabelGateway({
      async complete(input: { prompt: string }) {
        completions.push({ prompt: input.prompt });
        return {
          text: JSON.stringify([
            { id: "doc-refund", label: "Whether refunds are available", description: "Refund eligibility and timing" },
          ]),
        };
      },
    } as never, "Question:\n{{question}}\n\nLanguage:\n{{conversationLanguage}}\n\nGroups:\n{{groups}}");

    await gateway.label({
      question: "Can I get my money back?",
      conversationLanguage: "en",
      groups: [{
        id: "doc-refund",
        documentIds: ["doc-refund"],
        documents: [{ documentId: "doc-refund", title: "Refund Policy" }],
        share: 0.5,
        separation: 0.6,
      }],
    });

    expect(completions[0]?.prompt).toContain("Can I get my money back?");
    expect(completions[0]?.prompt).toContain("Refund Policy");
  });

  it("auto-picks the query-relevant document for the issue-686 refund policy repro", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group) => ({
        id: group.id,
        label: group.id === "doc-left"
          ? "Whether refunds are available"
          : "Whether shipping details apply",
      }))),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "What is your refund policy?",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "Refund Policy",
        leftSimilarities: [0.86, 0.84],
        rightTitle: "Shipping FAQ",
        rightSimilarities: [0.56, 0.54],
      }),
      conversationLanguage: "en",
    });

    expect(candidates).toHaveLength(2);
    const refund = candidates.find((item) => item.id === "doc-left");
    const shipping = candidates.find((item) => item.id === "doc-right");
    expect(refund).toBeDefined();
    expect(shipping).toBeDefined();
    expect(candidates.map((item) => item.label)).toEqual([
      "Whether refunds are available",
      "Whether shipping details apply",
    ]);
    expect(refund!.confidence - shipping!.confidence).toBeGreaterThanOrEqual(0.15);
    expect(decideClarification(candidates, { floor: 0, margin: 0.15, maxOptions: 4 })).toMatchObject({
      kind: "auto_pick",
      candidate: expect.objectContaining({ id: "doc-left" }),
      reason: "clear_margin",
    });
  });

  it("keeps comparable-relevance separated groups inside the ask margin", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group) => ({
        id: group.id,
        label: group.id === "doc-left"
          ? "Whether the visitor means posture practice"
          : "Whether the visitor means meditation practice",
      }))),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about yoga.",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "Hatha Yoga Foundations",
        leftSimilarities: [0.82, 0.8],
        rightTitle: "Raja Yoga Meditation",
        rightSimilarities: [0.8, 0.78],
      }),
      conversationLanguage: "en",
    });

    expect(candidates).toHaveLength(2);
    const [top, runnerUp] = [...candidates].sort((left, right) => right.confidence - left.confidence);
    expect(top!.confidence - runnerUp!.confidence).toBeLessThan(0.15);
    expect(decideClarification(candidates, { floor: 0, margin: 0.15, maxOptions: 4 })).toMatchObject({
      kind: "ask",
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: "doc-left" }),
        expect.objectContaining({ id: "doc-right" }),
      ]),
    });
  });

  it("does not invoke embeddings or labels when fewer than two groups meet the share precondition", async () => {
    const embeddingReader = { readChunkEmbeddings: vi.fn() };
    const labelGateway = { label: vi.fn<(input: LabelInput) => LabelOutput>() };
    const service = new SenseGroupingService({ embeddingReader, labelGateway, policy });

    await expect(service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about yoga.",
      rankedCandidates: dominantHathaYogaCandidates(),
      conversationLanguage: "en",
    })).resolves.toEqual([]);

    expect(embeddingReader.readChunkEmbeddings).not.toHaveBeenCalled();
    expect(labelGateway.label).not.toHaveBeenCalled();
  });

  it("marks missing LLM labels without falling back to document titles", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async () => [
        { id: "doc-left", label: "Whether refunds are available" },
      ]),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Can I get my money back?",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "Refund Policy",
        leftSimilarities: [0.82, 0.8],
        rightTitle: "Shipping FAQ",
        rightSimilarities: [0.8, 0.78],
      }),
      conversationLanguage: "en",
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "doc-left",
        label: "Whether refunds are available",
        labelStatus: "generated",
      }),
      expect.objectContaining({
        id: "doc-right",
        label: "",
        labelStatus: "missing",
      }),
    ]);
    // A labeling miss must never leak the document id or title as a visitor-facing
    // label; the missing label is represented honestly as an empty string.
    expect(candidates.map((candidate) => candidate.label)).not.toContain("Shipping FAQ");
    expect(candidates.map((candidate) => candidate.label)).not.toContain("doc-right");
  });

  it("treats rejected LLM labels as missing so retrieval sense clarification can auto-pick", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async () => {
        throw new Error("rate limited");
      }),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Can I get my money back?",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "Refund Policy",
        leftSimilarities: [0.82, 0.8],
        rightTitle: "Shipping FAQ",
        rightSimilarities: [0.8, 0.78],
      }),
      conversationLanguage: "en",
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "doc-left",
        label: "",
        labelStatus: "missing",
      }),
      expect.objectContaining({
        id: "doc-right",
        label: "",
        labelStatus: "missing",
      }),
    ]);

    await expect(evaluateRetrievalSenseClarification({
      detector: { detect: vi.fn(async () => candidates) },
      workspaceId: "workspace-1",
      rankedCandidates: [],
      conversationId: "conversation-1",
      messageId: "message-1",
      originalQuery: "Can I get my money back?",
      conversationLanguage: "en",
      policy: { floor: 0, margin: 0.15, askMargin: 0.03, maxOptions: 4 },
      suppressAsk: false,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })).resolves.toMatchObject({
      kind: "proceed",
      documentScope: ["doc-left"],
      stage: expect.objectContaining({
        outputs: expect.objectContaining({
          decision: "auto_picked",
          reason: "label_fallback",
          chosenCandidateId: "doc-left",
        }),
      }),
    });
  });

  it("returns no candidates when structurally qualified groups are not semantically separated", async () => {
    const service = new SenseGroupingService({
      policy,
      embeddingReader: {
        readChunkEmbeddings: vi.fn(async () => new Map([
          ["hatha-1", [1, 0]],
          ["hatha-2", [1, 0.01]],
          ["raja-1", [0.99, 0]],
          ["raja-2", [0.99, 0.01]],
        ])),
      },
      labelGateway: { label: vi.fn() },
    });

    await expect(service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about yoga.",
      rankedCandidates: hathaRajaYogaCandidates().slice(0, 4),
      conversationLanguage: "en",
    })).resolves.toEqual([]);
  });

  it("orders groups deterministically by share, similarity, then document id and caps options", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group) => ({
        id: group.id,
        label: `Meaning represented by ${group.id}`,
      }))),
    };
    const service = new SenseGroupingService({
      policy: { ...policy, maxOptions: 2 },
      embeddingReader: {
        readChunkEmbeddings: vi.fn(async () => new Map([
          ["hatha-1", [1, 0]],
          ["hatha-2", [1, 0]],
          ["raja-1", [0, 1]],
          ["raja-2", [0, 1]],
          ["spanish-hatha-1", [-1, 0]],
        ])),
      },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about yoga.",
      rankedCandidates: hathaRajaYogaCandidates(),
      conversationLanguage: "es",
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["doc-hatha", "doc-raja"]);
    expect(labelGateway.label).toHaveBeenCalledWith(expect.objectContaining({
      conversationLanguage: "es",
    }));
  });

  it("tags candidates complementary when the label gateway judges the groups a single intent", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group) => ({
        id: group.id,
        label: group.id === "doc-left" ? "What Kriya Yoga is" : "How to begin Kriya Yoga",
        relationship: "complementary" as const,
      }))),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "What is Kriya Yoga and how do I learn it?",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "About Kriya Yoga",
        leftSimilarities: [0.82, 0.8],
        rightTitle: "Learning Kriya Yoga",
        rightSimilarities: [0.8, 0.78],
      }),
      conversationLanguage: "en",
    });

    expect(candidates.map((candidate) => candidate.relationship)).toEqual([
      "complementary",
      "complementary",
    ]);
  });

  it("leaves candidates untagged when the gateway omits or splits the relationship judgment", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group, index) => ({
        id: group.id,
        label: group.id === "doc-left" ? "Whether refunds are available" : "Whether shipping applies",
        // Only one group carries a relationship, and it is exclusive: the set must
        // fall back to the exclusive path bit-for-bit.
        ...(index === 0 ? { relationship: "exclusive" as const } : {}),
      }))),
    };
    const service = new SenseGroupingService({
      policy,
      embeddingReader: { readChunkEmbeddings: vi.fn(async () => separatedEmbeddings()) },
      labelGateway,
    });

    const candidates = await service.detect({
      workspaceId: "workspace-1",
      question: "Tell me about refunds and shipping.",
      rankedCandidates: sameShapeCandidates({
        leftTitle: "Refund Policy",
        leftSimilarities: [0.82, 0.8],
        rightTitle: "Shipping FAQ",
        rightSimilarities: [0.8, 0.78],
      }),
      conversationLanguage: "en",
    });

    expect(candidates.every((candidate) => candidate.relationship !== "complementary")).toBe(true);
  });
});

const complementaryCandidate = (
  id: string,
  confidence: number,
): RetrievalSenseClarificationCandidate => ({
  id,
  label: id === "doc-left" ? "What Kriya Yoga is" : "How to begin Kriya Yoga",
  labelStatus: "generated",
  confidence,
  relationship: "complementary",
  payload: { documentIds: [id] },
});

describe("evaluateRetrievalSenseClarification complementary facets", () => {
  const basePolicy = { floor: 0, margin: 0.15, askMargin: 0.03, maxOptions: 4 };

  it("proceeds without clarification, without document scoping, and records compatible_facets", async () => {
    const candidates = [
      complementaryCandidate("doc-left", 0.61),
      complementaryCandidate("doc-right", 0.6),
    ];

    const effect = await evaluateRetrievalSenseClarification({
      detector: { detect: vi.fn(async () => candidates) },
      workspaceId: "workspace-1",
      rankedCandidates: [],
      conversationId: "conversation-1",
      messageId: "message-1",
      originalQuery: "What is Kriya Yoga and how do I learn it?",
      conversationLanguage: "en",
      policy: basePolicy,
      suppressAsk: false,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(effect).toMatchObject({
      kind: "proceed",
      stage: expect.objectContaining({
        outputs: expect.objectContaining({
          surface: "retrieval_sense",
          reason: "compatible_facets",
        }),
      }),
    });
    expect(effect && "documentScope" in effect ? effect.documentScope : undefined).toBeUndefined();
  });

  it("still asks when the same well-separated groups are judged exclusive readings", async () => {
    const candidates = [
      { ...complementaryCandidate("doc-left", 0.61), relationship: undefined },
      { ...complementaryCandidate("doc-right", 0.6), relationship: undefined },
    ];

    const effect = await evaluateRetrievalSenseClarification({
      detector: { detect: vi.fn(async () => candidates) },
      workspaceId: "workspace-1",
      rankedCandidates: [],
      conversationId: "conversation-1",
      messageId: "message-1",
      originalQuery: "Do you mean posture or meditation?",
      conversationLanguage: "en",
      policy: basePolicy,
      suppressAsk: false,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(effect?.kind).toBe("ask");
  });
});

describe("phraseRetrievalSenseAsk", () => {
  const askStage = {
    id: "clarification",
    kind: "clarification" as const,
    status: "applied" as const,
    startedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:00:00.000Z",
    outputs: { surface: "retrieval_sense", decision: "asked" },
  };
  const presentable: RetrievalSenseClarificationCandidate[] = [
    { id: "doc-left", label: "Posture practice", labelStatus: "generated", confidence: 0.6, payload: { documentIds: ["doc-left"] } },
    { id: "doc-right", label: "Meditation practice", labelStatus: "generated", confidence: 0.59, payload: { documentIds: ["doc-right"] } },
  ];

  it("drops candidates whose label is empty or equal to their id", () => {
    const filtered = presentableSenseCandidates([
      ...presentable,
      { id: "doc-empty", label: "", labelStatus: "missing", confidence: 0.4, payload: { documentIds: ["doc-empty"] } },
      { id: "doc-id", label: "doc-id", labelStatus: "generated", confidence: 0.4, payload: { documentIds: ["doc-id"] } },
    ]);
    expect(filtered.map((candidate) => candidate.id)).toEqual(["doc-left", "doc-right"]);
  });

  it("returns an ask when at least two options are presentable and the lead-in is real", async () => {
    const result = await phraseRetrievalSenseAsk({
      candidates: presentable,
      askStage,
      phraseQuestion: async () => "Which did you mean?\n\n1. Posture practice\n2. Meditation practice",
    });
    expect(result.kind).toBe("ask");
    expect(result.kind === "ask" && result.presented.map((candidate) => candidate.id)).toEqual(["doc-left", "doc-right"]);
  });

  it("falls back silently to phrasing_fallback when the lead-in degenerates to a bare label", async () => {
    const result = await phraseRetrievalSenseAsk({
      candidates: presentable,
      askStage,
      phraseQuestion: async () => "Posture practice",
    });
    expect(result.kind).toBe("fallback");
    expect(result.kind === "fallback" && result.documentScope).toEqual(["doc-left"]);
    expect(result.stage.outputs).toMatchObject({
      surface: "retrieval_sense",
      decision: "auto_picked",
      reason: "phrasing_fallback",
      chosenCandidateId: "doc-left",
    });
  });

  it("falls back when fewer than two options survive the presentable guard", async () => {
    const result = await phraseRetrievalSenseAsk({
      candidates: [
        presentable[0]!,
        { id: "doc-id", label: "doc-id", confidence: 0.5, payload: { documentIds: ["doc-id"] } },
      ],
      askStage,
      phraseQuestion: async () => "Which did you mean?",
    });
    expect(result.kind).toBe("fallback");
    expect(result.kind === "fallback" && result.documentScope).toEqual(["doc-left"]);
  });
});
