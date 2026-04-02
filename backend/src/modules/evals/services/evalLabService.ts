import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { ChatHistoryService } from "../../chat/services/chatHistoryService.js";
import type {
  EvalCaseComparison,
  EvalCaseCreateInput,
  EvalCaseRecord,
  EvalCaseResultRecord,
  EvalCaseScore,
  EvalDatasetDetail,
  EvalDatasetRecord,
  EvalDatasetSummary,
  EvalImportDraft,
  EvalRunComparison,
  EvalRunRecord,
} from "../domain/evalTypes.js";
import { EvalReplayService } from "./evalReplayService.js";

export interface EvalRepositoryPort {
  listDatasets(workspaceId: string): Promise<EvalDatasetSummary[]>;
  createDataset(workspaceId: string, input: {
    name: string;
    description?: string;
    createdByAccountId?: string | null;
  }): Promise<EvalDatasetRecord>;
  findDatasetById(workspaceId: string, datasetId: string): Promise<EvalDatasetRecord | null>;
  listCases(datasetId: string): Promise<EvalCaseRecord[]>;
  createCase(workspaceId: string, datasetId: string, input: EvalCaseCreateInput): Promise<EvalCaseRecord>;
  listRuns(datasetId: string): Promise<EvalRunRecord[]>;
  createRun(workspaceId: string, datasetId: string, input: {
    label?: string | null;
    baselineRunId?: string | null;
    createdByAccountId?: string | null;
    runMetadata?: Record<string, unknown>;
    summary: EvalRunRecord["summary"];
    results: EvalCaseResultRecord[];
  }): Promise<EvalRunRecord>;
  findRunById(workspaceId: string, datasetId: string, runId: string): Promise<EvalRunRecord | null>;
}

const MAX_CONTEXT_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_QUERY_LENGTH = 2_000;

const normalizeText = (value: string, maxLength: number): string => value.trim().slice(0, maxLength);

const normalizeExpectedCitations = (
  citations: unknown,
): Array<{ documentId: string; title: string }> => {
  if (!Array.isArray(citations)) {
    return [];
  }

  return citations.flatMap((citation) => {
    if (!citation || typeof citation !== "object") {
      return [];
    }

    const documentId =
      "documentId" in citation && typeof citation.documentId === "string"
        ? citation.documentId
        : null;
    const title =
      "title" in citation && typeof citation.title === "string"
        ? citation.title.trim()
        : "";

    if (!documentId) {
      return [];
    }

    return [{ documentId, title }];
  });
};

export class EvalLabService {
  constructor(
    private readonly repository: EvalRepositoryPort,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly replayService: EvalReplayService,
  ) {}

  listDatasets(workspaceId: string): Promise<EvalDatasetSummary[]> {
    return this.repository.listDatasets(workspaceId);
  }

  async createDataset(
    workspaceId: string,
    input: { name: string; description?: string; createdByAccountId?: string | null },
  ): Promise<EvalDatasetSummary> {
    const name = normalizeText(input.name, 120);
    if (name.length === 0) {
      throw badRequest("Dataset name is required");
    }
    const dataset = await this.repository.createDataset(workspaceId, {
      ...input,
      name,
      description: normalizeText(input.description ?? "", 500),
    });
    return {
      ...dataset,
      caseCount: 0,
      runCount: 0,
      lastRunAt: null,
    };
  }

  async getDataset(workspaceId: string, datasetId: string): Promise<EvalDatasetDetail> {
    const dataset = await this.repository.findDatasetById(workspaceId, datasetId);
    if (!dataset) {
      throw notFound("Eval dataset not found");
    }

    const [cases, runs] = await Promise.all([
      this.repository.listCases(datasetId),
      this.repository.listRuns(datasetId),
    ]);

    return {
      ...dataset,
      cases,
      runs,
    };
  }

  async importConversationTurn(
    workspaceId: string,
    input: { conversationId: string; assistantMessageId: string },
  ): Promise<EvalImportDraft> {
    const detail = await this.chatHistoryService.getConversation(workspaceId, input.conversationId, {
      limit: 200,
      offset: 0,
    });
    const assistantIndex = detail.messages.findIndex((message) => message.id === input.assistantMessageId && message.role === "assistant");
    if (assistantIndex < 0) {
      throw notFound("Assistant message not found in conversation");
    }

    const selectedAssistant = detail.messages[assistantIndex];
    const queryIndex = [...detail.messages.slice(0, assistantIndex)]
      .reverse()
      .findIndex((message) => message.role === "user");
    if (queryIndex < 0) {
      throw badRequest("Selected assistant turn does not have a preceding user message");
    }
    const selectedUserIndex = assistantIndex - 1 - queryIndex;
    const selectedUser = detail.messages[selectedUserIndex];
    const context = detail.messages
      .slice(Math.max(0, selectedUserIndex - MAX_CONTEXT_MESSAGES), selectedUserIndex)
      .map((message) => ({
        role: message.role,
        content: normalizeText(message.content, MAX_MESSAGE_LENGTH),
      }))
      .filter((message) => message.content.length > 0);

    const normalizedCitations = normalizeExpectedCitations(selectedAssistant.citations);
    const seededExpectations = {
      expectedDocumentIds: normalizedCitations.map((citation) => citation.documentId),
      expectedCitationTitles: normalizedCitations
        .map((citation) => citation.title)
        .filter((title) => title.length > 0),
      expectedRefusalBehavior: selectedAssistant.debug?.answerOutcome === "no_context_refusal" ? "refusal" : "answer",
      expectedAnswerOutcome: selectedAssistant.debug?.answerOutcome,
    } satisfies EvalCaseCreateInput["expectations"];

    const unavailable: string[] = [];
    if (!selectedAssistant.debug?.retrievalTrace) {
      unavailable.push("retrievalTrace");
    }
    if (!selectedAssistant.debug?.answerOutcome) {
      unavailable.push("answerOutcome");
    }

    return {
      title: normalizeText(selectedUser.content, 120) || "Imported chat case",
      query: normalizeText(selectedUser.content, MAX_QUERY_LENGTH),
      conversationContext: context,
      sourceType: "conversation_import",
      provenance: {
        conversationId: detail.conversationId,
        assistantMessageId: selectedAssistant.id,
        sourceChannel: detail.sourceChannel,
      },
      seededExpectations,
      unavailable,
    };
  }

  async createCase(
    workspaceId: string,
    datasetId: string,
    input: EvalCaseCreateInput,
  ): Promise<EvalCaseRecord> {
    const dataset = await this.repository.findDatasetById(workspaceId, datasetId);
    if (!dataset) {
      throw notFound("Eval dataset not found");
    }
    const title = normalizeText(input.title, 120);
    const query = normalizeText(input.query, MAX_QUERY_LENGTH);
    if (title.length === 0 || query.length === 0) {
      throw badRequest("Case title and query are required");
    }

    const conversationContext = (input.conversationContext ?? [])
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: normalizeText(message.content, MAX_MESSAGE_LENGTH),
      }))
      .filter((message) => message.content.length > 0);

    const expectations = input.expectations ?? {};
    const hasExpectation =
      Boolean(expectations.expectedDocumentIds?.length) ||
      Boolean(expectations.expectedCitationTitles?.length) ||
      Boolean(expectations.expectedRefusalBehavior) ||
      Boolean(expectations.expectedAnswerOutcome) ||
      Boolean(expectations.requiredPhrases?.length) ||
      Boolean(expectations.forbiddenPhrases?.length) ||
      Boolean(expectations.latencyBudgetMs);
    if (!hasExpectation) {
      throw badRequest("At least one expectation is required");
    }

    return this.repository.createCase(workspaceId, datasetId, {
      ...input,
      title,
      query,
      conversationContext,
    });
  }

  async runDataset(
    workspaceId: string,
    datasetId: string,
    input: {
      label?: string | null;
      baselineRunId?: string | null;
      createdByAccountId?: string | null;
      runMetadata?: Record<string, unknown>;
    } = {},
  ): Promise<EvalRunRecord> {
    const dataset = await this.repository.findDatasetById(workspaceId, datasetId);
    if (!dataset) {
      throw notFound("Eval dataset not found");
    }

    const [cases, existingRuns] = await Promise.all([
      this.repository.listCases(datasetId),
      this.repository.listRuns(datasetId),
    ]);
    if (cases.length === 0) {
      throw badRequest("Eval dataset has no cases");
    }

    const baselineRun =
      input.baselineRunId
        ? existingRuns.find((run) => run.id === input.baselineRunId) ?? null
        : existingRuns[0] ?? null;

    const results: EvalCaseResultRecord[] = [];
    for (const evalCase of cases) {
      const replay = await this.replayService.replay({
        workspaceId,
        query: evalCase.query,
        conversationContext: evalCase.conversationContext,
      });
      const score = this.scoreCase(evalCase, replay);
      results.push({
        caseId: evalCase.id,
        status: score.overallVerdict,
        score,
        diagnostics: replay,
      });
    }

    const comparedResults = baselineRun
      ? this.applyComparison(cases, results, baselineRun)
      : results;

    const summary = {
      totalCases: comparedResults.length,
      passCount: comparedResults.filter((result) => result.status === "pass").length,
      failCount: comparedResults.filter((result) => result.status === "fail").length,
      skippedCount: comparedResults.filter((result) => result.status === "skipped").length,
      invalidCount: comparedResults.filter((result) => result.status === "invalid").length,
      improvementCount: comparedResults.filter((result) => result.comparisonOutcome === "improved").length,
      regressionCount: comparedResults.filter((result) => result.comparisonOutcome === "regressed").length,
      unchangedCount: comparedResults.filter((result) => result.comparisonOutcome === "unchanged").length,
    };

    return this.repository.createRun(workspaceId, datasetId, {
      label: input.label ?? null,
      baselineRunId: baselineRun?.id ?? null,
      createdByAccountId: input.createdByAccountId ?? null,
      runMetadata: input.runMetadata ?? {},
      summary,
      results: comparedResults,
    });
  }

  async getRun(workspaceId: string, datasetId: string, runId: string): Promise<EvalRunRecord> {
    const run = await this.repository.findRunById(workspaceId, datasetId, runId);
    if (!run) {
      throw notFound("Eval run not found");
    }
    return run;
  }

  async compareRun(
    workspaceId: string,
    datasetId: string,
    runId: string,
    baselineRunId?: string | null,
  ): Promise<EvalRunComparison> {
    const [candidateRun, runs, cases] = await Promise.all([
      this.getRun(workspaceId, datasetId, runId),
      this.repository.listRuns(datasetId),
      this.repository.listCases(datasetId),
    ]);
    const baselineRun =
      baselineRunId
        ? runs.find((run) => run.id === baselineRunId) ?? null
        : candidateRun.baselineRunId
          ? runs.find((run) => run.id === candidateRun.baselineRunId) ?? null
          : runs.find((run) => run.id !== candidateRun.id) ?? null;

    if (!baselineRun) {
      throw badRequest("No baseline run is available for comparison");
    }

    const byCaseTitle = new Map(cases.map((evalCase) => [evalCase.id, evalCase.title]));
    const casesComparison = candidateRun.results.map<EvalCaseComparison>((result) => ({
      caseId: result.caseId,
      title: byCaseTitle.get(result.caseId) ?? "Untitled case",
      outcome: result.comparisonOutcome ?? "unscored",
      reasons: result.comparisonReasons ?? [],
      baselineStatus: baselineRun.results.find((entry) => entry.caseId === result.caseId)?.status,
      candidateStatus: result.status,
    }));

    return {
      baselineRunId: baselineRun.id,
      candidateRunId: candidateRun.id,
      regressions: casesComparison.filter((entry) => entry.outcome === "regressed").length,
      improvements: casesComparison.filter((entry) => entry.outcome === "improved").length,
      unchanged: casesComparison.filter((entry) => entry.outcome === "unchanged").length,
      unscored: casesComparison.filter((entry) => entry.outcome === "unscored").length,
      cases: casesComparison,
    };
  }

  private scoreCase(evalCase: EvalCaseRecord, replay: EvalCaseResultRecord["diagnostics"]): EvalCaseScore {
    const citations = replay.citations ?? [];
    const citationTitles = citations.map((citation) => citation.title);
    const documentIds = citations.map((citation) => citation.documentId);
    const expectedRefusal = evalCase.expectations.expectedRefusalBehavior;
    const actualRefusal = replay.answerOutcome === "no_context_refusal" ? "refusal" : "answer";
    const verdict = (passed: boolean): "pass" | "fail" => (passed ? "pass" : "fail");

    const documentMatch = evalCase.expectations.expectedDocumentIds?.length
      ? {
          verdict: verdict(evalCase.expectations.expectedDocumentIds.every((id) => documentIds.includes(id))),
          expected: evalCase.expectations.expectedDocumentIds,
          actual: documentIds,
          reason: "Expected supporting documents were not all cited.",
        }
      : { verdict: "unscored" as const };
    const citationMatch = evalCase.expectations.expectedCitationTitles?.length
      ? {
          verdict: verdict(evalCase.expectations.expectedCitationTitles.every((title) => citationTitles.includes(title))),
          expected: evalCase.expectations.expectedCitationTitles,
          actual: citationTitles,
          reason: "Expected citation titles were not all present.",
        }
      : { verdict: "unscored" as const };
    const refusalMatch = expectedRefusal
      ? {
          verdict: verdict(expectedRefusal === actualRefusal),
          expected: expectedRefusal,
          actual: actualRefusal,
          reason: "Refusal behavior changed.",
        }
      : { verdict: "unscored" as const };
    const answerOutcomeMatch = evalCase.expectations.expectedAnswerOutcome
      ? {
          verdict: verdict(evalCase.expectations.expectedAnswerOutcome === replay.answerOutcome),
          expected: evalCase.expectations.expectedAnswerOutcome,
          actual: replay.answerOutcome,
          reason: "Answer outcome changed.",
        }
      : { verdict: "unscored" as const };
    const requiredPhrases = evalCase.expectations.requiredPhrases ?? [];
    const forbiddenPhrases = evalCase.expectations.forbiddenPhrases ?? [];
    const answerContainsPass =
      requiredPhrases.every((phrase) => replay.answer.toLowerCase().includes(phrase.toLowerCase())) &&
      forbiddenPhrases.every((phrase) => !replay.answer.toLowerCase().includes(phrase.toLowerCase()));
    const answerContainsMatch = requiredPhrases.length || forbiddenPhrases.length
      ? {
          verdict: verdict(answerContainsPass),
          expected: {
            requiredPhrases,
            forbiddenPhrases,
          },
          actual: replay.answer,
          reason: "Answer phrase checks changed.",
        }
      : { verdict: "unscored" as const };
    const latencyMatch = evalCase.expectations.latencyBudgetMs
      ? {
          verdict: verdict(replay.latencyMs <= evalCase.expectations.latencyBudgetMs),
          expected: evalCase.expectations.latencyBudgetMs,
          actual: replay.latencyMs,
          reason: "Latency budget exceeded.",
        }
      : { verdict: "unscored" as const };

    const dimensionResults = [documentMatch, citationMatch, refusalMatch, answerOutcomeMatch, answerContainsMatch, latencyMatch];
    const reasons = dimensionResults
      .filter((result) => result.verdict === "fail" && typeof result.reason === "string")
      .map((result) => result.reason as string);

    return {
      documentMatch,
      citationMatch,
      refusalMatch,
      answerOutcomeMatch,
      answerContainsMatch,
      latencyMatch,
      overallVerdict: reasons.length === 0 ? "pass" : "fail",
      reasons,
    };
  }

  private applyComparison(
    cases: EvalCaseRecord[],
    results: EvalCaseResultRecord[],
    baselineRun: EvalRunRecord,
  ): EvalCaseResultRecord[] {
    const baselineByCaseId = new Map(baselineRun.results.map((result) => [result.caseId, result]));
    const caseTitleById = new Map(cases.map((evalCase) => [evalCase.id, evalCase.title]));

    return results.map((result) => {
      const baseline = baselineByCaseId.get(result.caseId);
      if (!baseline) {
        return {
          ...result,
          comparisonOutcome: "unscored",
          comparisonReasons: ["No baseline result is available for this case."],
        };
      }

      if (baseline.status === "pass" && result.status === "fail") {
        return {
          ...result,
          comparisonOutcome: "regressed",
          comparisonReasons: result.score.reasons.length > 0
            ? result.score.reasons
            : [`${caseTitleById.get(result.caseId) ?? "Case"} regressed.`],
        };
      }

      if (baseline.status === "fail" && result.status === "pass") {
        return {
          ...result,
          comparisonOutcome: "improved",
          comparisonReasons: ["Case now passes all configured expectations."],
        };
      }

      return {
        ...result,
        comparisonOutcome: "unchanged",
        comparisonReasons: ["Case outcome is unchanged from the baseline run."],
      };
    });
  }
}
