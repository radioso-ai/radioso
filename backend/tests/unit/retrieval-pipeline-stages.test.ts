import { describe, expect, it } from "vitest";

import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { QueryInterpretationStageService } from "../../src/modules/retrieval/services/queryInterpretationStage.js";
import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { RetrievalDiagnosticsStageService } from "../../src/modules/retrieval/services/retrievalDiagnosticsStage.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";

describe("retrieval pipeline stages", () => {
  it("keeps structured query literals during query interpretation", async () => {
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
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeParsedQuery.semanticQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.activeParsedQuery.lexicalQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.activeQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.promptHistory).toEqual([]);
    expect(result.triggerAnalysis).toMatchObject({
      status: "skipped_not_configured",
      matchedRuleIds: [],
      matchCount: 0,
    });
  });

  it("skips trigger matching when no triggerable rules are configured", async () => {
    let triggerCalls = 0;
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          triggerCalls += 1;
          return {
            status: "applied",
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "What is mononuclear disease?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [
          {
            id: "always-on-language",
            field: "language",
            valueType: "string",
            operator: "equals",
            value: "en",
            effect: "boost",
            enabled: true,
            triggerMode: "always_on",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(triggerCalls).toBe(0);
    expect(result.triggerAnalysis).toMatchObject({
      status: "skipped_not_configured",
      matchedRuleIds: [],
      unmatchedRuleIds: [],
      matchCount: 0,
    });
  });

  it("records matched triggerable rules during query interpretation", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.93,
                reason: "The user is asking for an upcoming event.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
              {
                ruleId: "definitions-filter",
                matched: false,
                matchStrength: 0.08,
                reason: "The user is not asking for a definition-only answer.",
                triggerInstructionPreview: "Enact for pure definitions.",
              },
            ],
            matchedRuleIds: ["events-filter"],
            unmatchedRuleIds: ["definitions-filter"],
            matchCount: 1,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "When is the next conference?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "dateFrom",
            valueType: "date",
            operator: "gte",
            value: "today()",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
          {
            id: "definitions-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "glossary",
            effect: "boost",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for pure definitions.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis).toMatchObject({
      status: "applied",
      matchedRuleIds: ["events-filter"],
      unmatchedRuleIds: ["definitions-filter"],
      matchCount: 1,
      matcherVersion: "test",
    });
  });

  it("suppresses low-confidence trigger matches from enactment", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.42,
                reason: "The query loosely overlaps with upcoming events.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
            ],
            matchedRuleIds: ["events-filter"],
            unmatchedRuleIds: [],
            matchCount: 1,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Tell me something interesting happening soon.",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis.matchedRuleIds).toEqual([]);
    expect(result.triggerAnalysis.unmatchedRuleIds).toEqual(["events-filter"]);
    expect(result.triggerAnalysis.matchCount).toBe(0);
    expect(result.triggerAnalysis.consideredRules[0]).toMatchObject({
      ruleId: "events-filter",
      matched: false,
      matchStrength: 0.42,
    });
    expect(result.triggerAnalysis.consideredRules[0]?.reason).toContain("below the enactment threshold");
  });

  it("supports multiple trigger rules crossing the enactment threshold", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.94,
                reason: "The user is asking about an upcoming event.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
              {
                ruleId: "active-registration-filter",
                matched: true,
                matchStrength: 0.88,
                reason: "The question is also about currently open registration windows.",
                triggerInstructionPreview: "Enact for active registrations.",
              },
            ],
            matchedRuleIds: ["events-filter", "active-registration-filter"],
            unmatchedRuleIds: [],
            matchCount: 2,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Which upcoming camps still have open registration?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
          {
            id: "active-registration-filter",
            field: "registrationStatus",
            valueType: "string",
            operator: "equals",
            value: "open",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for active registrations.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis.matchedRuleIds).toEqual(["events-filter", "active-registration-filter"]);
    expect(result.triggerAnalysis.matchCount).toBe(2);
  });

  it("clears prompt history when rewrite marks a fresh subject", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "Eestis hetkel kehtiv kaibemaksumaar (kaibemaks)",
            semanticQuery: "Eestis hetkel kehtiv kaibemaksumaar",
            lexicalQuery: "Eestis kehtiv km maar (kaibemaks)",
            turnKind: "fresh_subject",
            proposedActiveSubject: "kaibemaksumaar Eestis",
            relatedEntities: ["tulumaks"],
            unresolved: false,
            confidence: 0.74,
          };
        },
      }),
    );

    const history = [
      {
        id: "u1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "user" as const,
        content: "Mis juhtub, kui ma ei maksa tulumaksu?",
        createdAt: new Date(),
      },
      {
        id: "a1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "assistant" as const,
        content: "Tulumaksu vastus",
        createdAt: new Date(),
      },
    ];

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "mis on hetkel kehtiv kaibemaks?",
        history,
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: history,
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeParsedQuery.semanticQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeParsedQuery.lexicalQuery).toBe("Eestis kehtiv km maar (kaibemaks)");
    expect(result.promptHistory).toEqual([]);
  });

  it("uses distinct semantic and lexical rewritten queries when both are provided", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "tulumaksuseadus 2015 paragraaf 4",
            semanticQuery: "tulumaksuseadus 2015 paragraaf 4",
            lexicalQuery: "tulumaksuseadus 2015 § 4",
            turnKind: "referential_followup",
            proposedActiveSubject: "tulumaksuseadus 2015",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.91,
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tulumaksuseadus 2015 paragraaf 4",
        history: [       
          {
            id: "u1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user" as const,
            content: "räägi tulumaksuseadusest",
            createdAt: new Date(),
          },
        ],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer section symbols and citation notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [
          {
            id: "u1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user" as const,
            content: "räägi tulumaksuseadusest",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeQuery).toBe("tulumaksuseadus 2015 paragraaf 4");
    expect(result.activeSemanticQuery).toBe("tulumaksuseadus 2015 paragraaf 4");
    expect(result.activeParsedQuery.lexicalQuery).toBe("tulumaksuseadus 2015 § 4");
  });

  it("rewrites standalone searches without requiring prior history", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "tulumaksuseadus paragrahv 4 osa 5",
            semanticQuery: "tulumaksuseadus paragrahv 4 osa 5",
            lexicalQuery: "tulumaksuseadus § 4 lg 5",
            turnKind: "fresh_subject",
            proposedActiveSubject: "tulumaksuseadus",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.88,
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tulumaksuseadus paragrahv 4 osa 5",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer section symbols and legal citation notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(result.rewrittenQuery.status).toBe("fallback");
    expect(result.activeSemanticQuery).toBe("tulumaksuseadus paragrahv 4 osa 5");
    expect(result.activeParsedQuery.lexicalQuery).toBe("tulumaksuseadus paragrahv 4 osa 5");
    expect(result.promptHistory).toEqual([]);
  });

  it("keeps prompt history smaller than the rewrite context window", async () => {
    const stage = new QueryInterpretationStageService(new QueryRewriteService());
    const history = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index + 1}`,
      conversationId: "c1",
      workspaceId: "a1",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index + 1}`,
      createdAt: new Date(),
    }));

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tell me more",
        history,
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: history,
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.promptHistory.map((message) => message.content)).toEqual(["turn-7", "turn-8", "turn-9", "turn-10"]);
  });

  it("keeps decomposed retrieval branches for history-free comparative turns", async () => {
    const interpretationStage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "who is narayani and arudra",
            semanticQuery: "who is narayani and arudra",
            lexicalQuery: "who is narayani and arudra",
            retrievalSubqueries: [
              {
                id: "",
                label: "Narayani",
                semanticQuery: "who is narayani",
                lexicalQuery: "narayani",
              },
              {
                id: "",
                label: "Arudra",
                semanticQuery: "who is arudra",
                lexicalQuery: "arudra",
              },
            ],
            turnKind: "comparative",
            proposedActiveSubject: "Narayani",
            relatedEntities: ["Arudra"],
            unresolved: false,
            confidence: 0.92,
          };
        },
      }),
    );

    const interpreted = await interpretationStage.execute({
      request: {
        workspaceId: "a1",
        query: "who is narayani and arudra?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and names.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(interpreted.activeRetrievalSubqueries).toHaveLength(2);
    expect(interpreted.activeRetrievalSubqueries.map((subquery) => subquery.label)).toEqual(["Narayani", "Arudra"]);

    const vectorQueries: string[] = [];
    const lexicalQueries: string[] = [];
    const retrievalStage = new CandidateRetrievalStageService(
      {
        async embedChunks(chunks: string[]) {
          return chunks.map((_: string, index: number) => [index + 1]);
        },
      } as never,
      {
        async search(input) {
          vectorQueries.push(String(input.queryEmbedding[0]));
          return [
            {
              chunkId: `semantic-${input.queryEmbedding[0]}`,
              documentId: `doc-semantic-${input.queryEmbedding[0]}`,
              title: input.queryEmbedding[0] === 1 ? "Narayani" : "Arudra",
              content: "profile",
              similarity: 0.9,
            },
          ];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          return [
            {
              chunkId: `lexical-${input.query}`,
              documentId: `doc-lexical-${input.query}`,
              title: input.query,
              content: "profile",
              similarity: 0.8,
            },
          ];
        },
      },
    );

    const retrieved = await retrievalStage.execute(interpreted);

    expect(vectorQueries).toEqual(["1", "2"]);
    expect(lexicalQueries).toEqual(["narayani", "arudra"]);
    expect(retrieved.retrievalBranches).toHaveLength(2);
    expect(retrieved.retrievalBranches.map((branch) => branch.label)).toEqual(["Narayani", "Arudra"]);
    expect(retrieved.originalContexts).toHaveLength(0);
    expect(retrieved.rewrittenContexts).toHaveLength(2);
    expect(retrieved.lexicalContexts).toHaveLength(2);
  });

  it("splits vector results between original and rewritten contexts", async () => {
    const contextStage = new RetrievalContextStageService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
            lexicalRewriteInstructions: "Prefer exact notation.",
            answerSupportPolicy: "strict",
            conversationMode: "guided",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            citationDisplayEnabled: true,
            customInstruction: "",
            metadataRules: [],
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
            semanticQuery: "summer retreat pricing",
            lexicalQuery: "summer retreat price",
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
    expect(result.activeParsedQuery.lexicalQuery).toBe("summer retreat price");
  });

  it("reports rejected rewrites as having run in diagnostics", async () => {
    const stage = new RetrievalDiagnosticsStageService(new RetrievalExecutionTelemetryService());

    const diagnostics = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "what about her later work?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep meaning.",
        lexicalRewriteInstructions: "Prefer exact notation.",
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
      originalParsedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      originalPreparedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      rewrittenQuery: {
        originalQuery: "what about her later work?",
        rewrittenQuery: "What did Arudra publish later?",
        effectiveQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        rewriteApplied: false,
        retrievalEligible: false,
        status: "rejected",
        confidence: 0.9,
        rejectionReason: "rewrite_not_materially_different",
      },
      activeQuery: "what about her later work?",
      activeParsedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      activeSemanticQuery: "what about her later work?",
      activeRetrievalSubqueries: [
        {
          id: "primary",
          label: "what about her later work?",
          semanticQuery: "what about her later work?",
          lexicalQuery: "what about her later work?",
        },
      ],
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "test",
      },
      promptHistory: [],
      continuityDecision: "rejected",
      activeEmbedding: [1, 0, 0],
      activeEmbeddingDurationMs: 0,
      originalContexts: [],
      rewrittenContexts: [],
      lexicalContexts: [],
      retrievalBranches: [],
      vectorFallbackApplied: false,
      normalizedCandidates: [],
      mergedCandidates: [],
      scoredCandidates: [],
      appliedConstraints: [],
      candidateFallbackApplied: false,
      triggerBackoff: {
        applied: false,
        relaxedRuleIds: [],
      },
      rerankedContexts: [],
      rerankStatus: "skipped",
      contexts: [],
      prompt: "prompt",
      citations: [],
      responseSettings: {
        citationDisplayEnabled: true,
        answerSupportPolicy: "strict",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
      },
    });

    expect(diagnostics.rewriteStatus).toBe("rejected");
    expect(diagnostics.rewriteRan).toBe(true);
  });
});
