import { describe, expect, it } from "vitest";

import { defaultAttributeControls } from "../../src/modules/settings/domain/retrievalSettings.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { QueryInterpretationStageService } from "../../src/modules/retrieval/services/queryInterpretationStage.js";
import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";

describe("retrieval pipeline stages", () => {
  it("strips hard_filter literals during query interpretation", async () => {
    const stage = new QueryInterpretationStageService(new QueryRewriteService());

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Find retreats in Estonia under 300 EUR",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
        customInstruction: "",
        attributeControls: defaultAttributeControls().map((control) =>
          control.family === "location" || control.family === "money_value"
            ? { ...control, mode: "hard_filter" as const }
            : control,
        ),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeParsedQuery.semanticQuery).toBe("retreats");
    expect(result.activeParsedQuery.lexicalQuery).toBe("retreats");
    expect(result.activeQuery).toBe("Find retreats in Estonia under 300 EUR");
  });

  it("splits vector results between original and rewritten contexts", async () => {
    const contextStage = new RetrievalContextStageService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            chunkingStrategy: "fixed_window",
            customInstruction: "",
            attributeControls: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      new ConversationContextService(),
    );
    const interpretationStage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "summer retreat pricing",
            turnKind: "referential_followup",
            proposedActiveSubject: "summer retreat",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.9,
          };
        },
      }),
    );
    const retrievalStage = new CandidateRetrievalStageService(
      {
        async embedChunks() {
          return [[1, 0, 0]];
        },
      } as never,
      {
        async search() {
          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Summer Retreat",
              content: "Summer retreat in Estonia costs 290 EUR.",
              similarity: 0.6,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
    );

    const context = await contextStage.execute({
      workspaceId: "a1",
      query: "Is it under 300 EUR?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Tell me about the summer retreat",
          createdAt: new Date(),
        },
      ],
    });
    const interpretation = await interpretationStage.execute(context);
    const result = await retrievalStage.execute(interpretation);

    expect(result.originalContexts).toEqual([]);
    expect(result.rewrittenContexts).toHaveLength(1);
    expect(result.lexicalContexts).toEqual([]);
    expect(result.activeQuery).toBe("summer retreat pricing");
  });
});
