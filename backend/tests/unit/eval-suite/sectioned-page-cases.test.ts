import { describe, expect, it } from "vitest";

import type { EvalRunObservedOutput } from "../../../src/modules/eval/domain/types.js";
import {
  evaluateTraceAssertion,
  parseConversationQualityCases,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
} from "../../../src/modules/eval/suite/index.js";
import type { WorkbenchReplayResult } from "../../../src/modules/chat/services/workbenchReplayRunner.js";
import { FixedWindowChunkingStrategy } from "../../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { renderSearchText } from "../../../src/modules/retrieval/services/searchTextRenderer.js";
import { deriveChunkSection, deriveDocumentSubject } from "../../../src/modules/retrieval/services/subjectIdentityService.js";
import { defaultIngestionSettings } from "../../../src/modules/settings/domain/ingestionSettings.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";
import { createWorkbenchReplayRunnerPort, type DocumentPassagePages } from "../../../scripts/evalRunnerAdapter.js";
import { conversationQualityAgentConfig } from "../../fixtures/conversation-quality/index.js";
import {
  MAESTRALE_SECTION_PASSAGE,
  PLANET_SECTION_PASSAGE,
  sectionedPageCases,
  sectionedPageDocuments,
} from "../../fixtures/conversation-quality/sectionedPageCases.js";

const PAGE = "page-doc";
const HELP = "help-doc";
const PASSAGE = "Planet costs €579 a month";

const lexicalStage = (query: string, chunks: Array<{ chunkId: string; documentId: string }>) => ({
  stageId: `lexical_${query}`,
  kind: "lexical",
  status: "applied",
  settings: { query },
  outputs: { candidateCount: chunks.length, chunks },
});

const retrievalTurn = (
  searches: Array<ReturnType<typeof lexicalStage>>,
  passageTexts?: Record<string, string>,
): ConversationQualityObservedOutput => ({
  retrievedChunks: [],
  turnTrace: {
    version: 1,
    spine: {
      traceId: "trace",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [
        {
          id: "dispatch:retrieval.answer",
          kind: "skill_dispatch",
          status: "applied",
          subTrace: { namespace: "retrieval", version: 1, payload: { stages: searches } },
        },
      ] as never,
    },
  } satisfies EvalRunObservedOutput["turnTrace"],
  ...(passageTexts ? { passageTexts } : {}),
});

const assertion = {
  type: "retrieval_lexical_top_k_includes_passage",
  documentId: PAGE,
  passage: PASSAGE,
  k: 3,
} as const;

const pageTexts = {
  "help-0": "You can change plan at any time, for example from Satellite to the Planet plan.",
  "page-1": "### Satellite\n\nSatellite costs €149 a month.\n\n### Planet\n\nPlanet costs €579 a month.",
  "page-2": "Star is the tier above Planet. Top-ups are not available on the free plan.",
  "page-4": "Every plan uses one model. On Planet the customer can add their own keys.",
};

describe("retrieval_lexical_top_k_includes_passage", () => {
  it("passes when a lexical search ranks the passage within its first k hits", () => {
    const output = retrievalTurn(
      [
        lexicalStage("Planet plan", [
          { chunkId: "help-0", documentId: HELP },
          { chunkId: "page-4", documentId: PAGE },
          { chunkId: "page-2", documentId: PAGE },
        ]),
        lexicalStage("Planet", [
          { chunkId: "help-0", documentId: HELP },
          { chunkId: "page-1", documentId: PAGE },
          { chunkId: "page-2", documentId: PAGE },
        ]),
      ],
      pageTexts,
    );

    const verdict = evaluateTraceAssertion(assertion, output);

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("\"Planet\"");
  });

  it("fails when no lexical search ranks the passage within its first k hits, naming each search", () => {
    const output = retrievalTurn(
      [
        lexicalStage("Planet plan", [
          { chunkId: "help-0", documentId: HELP },
          { chunkId: "page-4", documentId: PAGE },
          { chunkId: "page-2", documentId: PAGE },
          { chunkId: "page-1", documentId: PAGE },
        ]),
      ],
      pageTexts,
    );

    const verdict = evaluateTraceAssertion(assertion, output);

    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("\"Planet plan\"");
    expect(verdict.reason).toContain("4");
  });

  it("counts only a hit of the named document, whatever another document's passage says", () => {
    const output = retrievalTurn(
      [lexicalStage("Planet", [{ chunkId: "copy-1", documentId: HELP }])],
      { ...pageTexts, "copy-1": pageTexts["page-1"] },
    );

    expect(evaluateTraceAssertion(assertion, output).status).toBe("fail");
  });

  it("errors when the runner read no passages of the named document", () => {
    const output = retrievalTurn([lexicalStage("Planet", [{ chunkId: "page-1", documentId: PAGE }])]);

    expect(evaluateTraceAssertion(assertion, output).status).toBe("error");
  });

  it("errors when no trace was captured", () => {
    expect(evaluateTraceAssertion(assertion, { retrievedChunks: [], passageTexts: pageTexts }).status).toBe("error");
  });

  it("refuses a case whose passage is empty or whose k is not a positive count", () => {
    const base = { id: "case", name: "case", query: "How much does the Planet plan cost?" };
    expect(() => parseConversationQualityCases([{ ...base, assertions: [{ ...assertion, k: 0 }] }])).toThrow();
    expect(() => parseConversationQualityCases([{ ...base, assertions: [{ ...assertion, passage: "" }] }])).toThrow();
    expect(parseConversationQualityCases([{ ...base, assertions: [assertion] }])).toHaveLength(1);
  });
});

type PassagePage = NonNullable<Awaited<ReturnType<DocumentPassagePages["listPageForDocument"]>>>;

describe("live runner passage texts", () => {
  const replayResult = { answer: "", resolvedConfig: { retrievedChunks: [] } } as unknown as WorkbenchReplayResult;
  const passageCase: ConversationQualityCase = {
    id: "passage-case",
    name: "passage case",
    query: "How much does the Planet plan cost?",
    assertions: [assertion],
  };

  const pagedChunks = () => {
    const reads: Array<{ documentId: string; startChunkIndex: number }> = [];
    const chunk = (id: string, chunkIndex: number, content: string): PassagePage["chunks"][number] => ({
      id,
      documentId: PAGE,
      workspaceId: "workspace",
      chunkIndex,
      content,
      searchText: null,
      startOffset: 0,
      endOffset: content.length,
      metadata: {},
      createdAt: new Date(0),
      embeddingDimensions: null,
    });
    const pages = new Map<number, PassagePage>([
      [0, { chunks: [chunk("page-0", 0, "Intro"), chunk("page-1", 1, pageTexts["page-1"])], totalChunks: 3, nextChunkIndex: 2 }],
      [2, { chunks: [chunk("page-2", 2, pageTexts["page-2"])], totalChunks: 3, nextChunkIndex: null }],
    ]);
    return {
      reads,
      listPageForDocument: async (input: { documentId: string; workspaceId: string; startChunkIndex: number; limit: number }) => {
        reads.push({ documentId: input.documentId, startChunkIndex: input.startChunkIndex });
        return pages.get(input.startChunkIndex) ?? null;
      },
    };
  };

  it("reads every passage of a document a passage assertion names, page after page", async () => {
    const passages = pagedChunks();
    const port = createWorkbenchReplayRunnerPort({ run: async () => replayResult }, {
      workspaceId: "workspace",
      agentId: "agent",
      baselineAgentConfig: conversationQualityAgentConfig,
      passages,
    });

    const output = await port.run(passageCase);

    expect(passages.reads).toEqual([
      { documentId: PAGE, startChunkIndex: 0 },
      { documentId: PAGE, startChunkIndex: 2 },
    ]);
    expect(output.passageTexts).toEqual({ "page-0": "Intro", "page-1": pageTexts["page-1"], "page-2": pageTexts["page-2"] });
  });

  it("reads no passages for a case without a passage assertion", async () => {
    const passages = pagedChunks();
    const port = createWorkbenchReplayRunnerPort({ run: async () => replayResult }, {
      workspaceId: "workspace",
      agentId: "agent",
      baselineAgentConfig: conversationQualityAgentConfig,
      passages,
    });

    const output = await port.run({ ...passageCase, assertions: [{ type: "turn_route", route: "retrieval" }] });

    expect(passages.reads).toEqual([]);
    expect(output.passageTexts).toBeUndefined();
  });
});

/**
 * What makes each sectioned page case a test of the lexical rewrite (#1912): the section that answers
 * holds the plan's bare name but not the word for its kind, and enough other passages hold both that
 * the search for the full phrase finds them and never relaxes to passages holding part of it.
 */
describe("sectioned page fixtures", () => {
  const searchWords = (text: string): Set<string> =>
    new Set(text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0));

  const searchTexts = async (documentIds: Set<string>) => {
    const texts: Array<{ documentId: string; content: string; words: Set<string> }> = [];
    for (const page of sectionedPageDocuments.filter((document) => documentIds.has(document.id))) {
      const chunks = await new FixedWindowChunkingStrategy().chunk({
        title: page.title,
        content: page.content,
        config: defaultIngestionSettings("workspace-1"),
      });
      for (const chunk of chunks) {
        const searchText = renderSearchText({
          title: page.title,
          subjectLabel: deriveDocumentSubject({ title: page.title, content: page.content }),
          sectionPath: deriveChunkSection(chunk.content),
          content: chunk.content,
        });
        texts.push({ documentId: page.id, content: chunk.content, words: searchWords(searchText) });
      }
    }
    return texts;
  };

  const shapes = [
    { caseId: "retrieval-sectioned-page-later-section-figure", passage: PLANET_SECTION_PASSAGE, name: "planet", kind: "plan" },
    { caseId: "retrieval-sectioned-page-later-section-figure-it", passage: MAESTRALE_SECTION_PASSAGE, name: "maestrale", kind: "piano" },
  ];

  it.each(shapes)("$caseId: the answering section holds the bare name alone, and passing mentions hold both words", async (shape) => {
    const evalCase = sectionedPageCases.find((candidate) => candidate.id === shape.caseId);
    const passageAssertion = evalCase?.assertions.find((candidate) => candidate.type === "retrieval_lexical_top_k_includes_passage");
    expect(passageAssertion).toMatchObject({ passage: shape.passage });
    const texts = await searchTexts(new Set(sectionedPageDocuments.map((document) => document.id)));

    const answering = texts.filter((text) => text.content.includes(shape.passage));
    expect(answering).toHaveLength(1);
    expect(answering[0]?.words.has(shape.name)).toBe(true);
    expect(answering[0]?.words.has(shape.kind)).toBe(false);

    const passingMentions = texts.filter((text) => text.words.has(shape.name) && text.words.has(shape.kind));
    expect(passingMentions.length).toBeGreaterThanOrEqual(RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsBelowAllTermsMatches);
  });
});
