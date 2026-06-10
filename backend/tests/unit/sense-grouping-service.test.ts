import { describe, expect, it, vi } from "vitest";

import {
  SenseGroupingService,
  type SenseLabelGateway,
  type SenseLabelGroup,
} from "../../src/modules/retrieval/services/senseGroupingService.js";
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
  groups: SenseLabelGroup[];
  conversationLanguage?: string;
  usageContext?: Parameters<SenseLabelGateway["label"]>[0]["usageContext"];
};

type LabelOutput = ReturnType<SenseLabelGateway["label"]>;

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

  it("does not invoke embeddings or labels when fewer than two groups meet the share precondition", async () => {
    const embeddingReader = { readChunkEmbeddings: vi.fn() };
    const labelGateway = { label: vi.fn<(input: LabelInput) => LabelOutput>() };
    const service = new SenseGroupingService({ embeddingReader, labelGateway, policy });

    await expect(service.detect({
      workspaceId: "workspace-1",
      rankedCandidates: dominantHathaYogaCandidates(),
      conversationLanguage: "en",
    })).resolves.toEqual([]);

    expect(embeddingReader.readChunkEmbeddings).not.toHaveBeenCalled();
    expect(labelGateway.label).not.toHaveBeenCalled();
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
      rankedCandidates: hathaRajaYogaCandidates().slice(0, 4),
      conversationLanguage: "en",
    })).resolves.toEqual([]);
  });

  it("orders groups deterministically by share, similarity, then document id and caps options", async () => {
    const labelGateway = {
      label: vi.fn<(input: LabelInput) => LabelOutput>(async (input) => input.groups.map((group) => ({
        id: group.id,
        label: group.documents[0]?.title ?? group.id,
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
      rankedCandidates: hathaRajaYogaCandidates(),
      conversationLanguage: "es",
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["doc-hatha", "doc-raja"]);
    expect(labelGateway.label).toHaveBeenCalledWith(expect.objectContaining({
      conversationLanguage: "es",
    }));
  });
});
