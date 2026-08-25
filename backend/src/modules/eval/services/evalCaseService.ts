import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseListItem,
  EvalCaseWithRuns,
} from "../domain/types.js";
import type { EvalRepositoryPort } from "./evalRepository.js";

export interface CreateEvalCaseInput {
  workspaceId: string;
  snapshotId: string;
  name: string;
  // 0 or more — a case can be created without assertions and configured later
  // in the eval editor. Running a case with zero assertions produces a
  // `recorded` run (output captured, no verdict).
  assertions?: EvalAssertion[];
}

const validateAssertion = (assertion: EvalAssertion): void => {
  switch (assertion.type) {
    case "retrieval_includes_document":
    case "retrieval_excludes_document":
      if (!assertion.documentId.trim()) {
        throw badRequest(`documentId is required for ${assertion.type} assertion`);
      }
      return;
    case "retrieval_top_k_includes_document":
      if (!assertion.documentId.trim()) {
        throw badRequest("documentId is required for retrieval_top_k_includes_document assertion");
      }
      if (!Number.isInteger(assertion.k) || assertion.k <= 0) {
        throw badRequest("k must be a positive integer for retrieval_top_k_includes_document assertion");
      }
      return;
    case "retrieval_document_order":
      if (!Array.isArray(assertion.documentIds) || assertion.documentIds.length === 0) {
        throw badRequest("documentIds must include at least one document for retrieval_document_order assertion");
      }
      if (assertion.documentIds.some((documentId) => !documentId.trim())) {
        throw badRequest("documentIds cannot be empty for retrieval_document_order assertion");
      }
      return;
    case "retrieval_chunk_metadata":
      if (!assertion.documentId.trim()) {
        throw badRequest("documentId is required for retrieval_chunk_metadata assertion");
      }
      if (Object.keys(assertion.metadata).length === 0) {
        throw badRequest("metadata must include at least one expected field for retrieval_chunk_metadata assertion");
      }
      return;
    case "answer_contains":
    case "answer_does_not_contain":
      if (!assertion.pattern.trim()) {
        throw badRequest(`pattern is required for ${assertion.type} assertion`);
      }
      if (assertion.matchMode !== "substring" && assertion.matchMode !== "regex") {
        throw badRequest(`matchMode must be 'substring' or 'regex' for ${assertion.type} assertion`);
      }
      if (assertion.matchMode === "regex") {
        try {
          new RegExp(assertion.pattern);
        } catch (err) {
          throw badRequest(
            `Invalid regex pattern for ${assertion.type} assertion: ${err instanceof Error ? err.message : "unknown error"}`,
          );
        }
      }
      return;
    case "llm_judge":
      if (!assertion.expectedAnswer.trim()) {
        throw badRequest("expectedAnswer is required for llm_judge assertion");
      }
      return;
  }
};

export class EvalCaseService {
  constructor(private readonly repository: EvalRepositoryPort) {}

  async create(input: CreateEvalCaseInput): Promise<EvalCase> {
    const snapshot = await this.repository.findSnapshot(input.workspaceId, input.snapshotId);
    if (!snapshot) {
      throw notFound("Snapshot not found");
    }
    const assertions = input.assertions ?? [];
    for (const a of assertions) validateAssertion(a);

    return this.repository.createCase({
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      name: input.name,
      assertions,
    });
  }

  async replaceAssertions(
    workspaceId: string,
    caseId: string,
    assertions: EvalAssertion[],
  ): Promise<EvalCase> {
    const existing = await this.repository.findCase(workspaceId, caseId);
    if (!existing) {
      throw notFound("Eval case not found");
    }
    for (const a of assertions) validateAssertion(a);
    return this.repository.updateCaseAssertions(workspaceId, caseId, assertions);
  }

  async rename(workspaceId: string, caseId: string, name: string): Promise<EvalCase> {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest("Case name cannot be empty");
    if (trimmed.length > 200) throw badRequest("Case name must be 200 characters or less");
    const existing = await this.repository.findCase(workspaceId, caseId);
    if (!existing) {
      throw notFound("Eval case not found");
    }
    return this.repository.updateCaseName(workspaceId, caseId, trimmed);
  }

  async list(workspaceId: string): Promise<EvalCase[]> {
    return this.repository.listCases(workspaceId);
  }

  async listWithLatestRun(workspaceId: string): Promise<EvalCaseListItem[]> {
    return this.repository.listCasesWithLatestRun(workspaceId);
  }

  async delete(workspaceId: string, caseId: string): Promise<void> {
    const deleted = await this.repository.deleteCase(workspaceId, caseId);
    if (!deleted) {
      throw notFound("Eval case not found");
    }
  }

  /** Workspace-scoped lookup without the run history, for callers that only need the case. */
  async findCase(workspaceId: string, caseId: string): Promise<EvalCase | null> {
    return this.repository.findCase(workspaceId, caseId);
  }

  /**
   * The case plus the agent whose captured configuration a replay of it runs against, and when
   * that configuration was frozen. Both live on the snapshot, so a caller that needs to attribute
   * a replay or date its baseline would otherwise have to read it separately.
   */
  async findCaseWithSourceAgent(
    workspaceId: string,
    caseId: string,
  ): Promise<(EvalCase & { sourceAgentId: string | null; snapshotCapturedAt: Date | null }) | null> {
    const evalCase = await this.findCase(workspaceId, caseId);
    if (!evalCase) {
      return null;
    }
    const snapshot = await this.repository.findSnapshot(workspaceId, evalCase.snapshotId);
    return {
      ...evalCase,
      sourceAgentId: snapshot?.sourceAgentId ?? null,
      snapshotCapturedAt: snapshot ? new Date(snapshot.capturedAt) : null,
    };
  }

  async getWithRuns(workspaceId: string, caseId: string): Promise<EvalCaseWithRuns> {
    const evalCase = await this.findCase(workspaceId, caseId);
    if (!evalCase) {
      throw notFound("Eval case not found");
    }
    const runs = await this.repository.listRunsForCase(workspaceId, caseId);
    return { ...evalCase, runs };
  }
}
