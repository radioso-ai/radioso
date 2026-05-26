import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  EvalAssertion,
  EvalCase,
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

  async getWithRuns(workspaceId: string, caseId: string): Promise<EvalCaseWithRuns> {
    const evalCase = await this.repository.findCase(workspaceId, caseId);
    if (!evalCase) {
      throw notFound("Eval case not found");
    }
    const runs = await this.repository.listRunsForCase(workspaceId, caseId);
    return { ...evalCase, runs };
  }
}
