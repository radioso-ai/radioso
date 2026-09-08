import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AnswerCoverageRepository } from "../../src/db/repositories/answerCoverageRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AnswerCoverageRepository", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AnswerCoverageRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const requestMessageId = randomUUID();

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [accountId, "Coverage test", `coverage-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [workspaceId, accountId, "Coverage", `coverage-${workspaceId}`]);
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [conversationId, workspaceId]);
    await database.query("INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', $4)", [requestMessageId, conversationId, workspaceId, "Can I attend one day?"]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("idempotently saves one assessment, orders reactions, and cascades request deletion", async () => {
    const input = {
      workspaceId,
      conversationId,
      requestMessageId,
      originatingTurnId: requestMessageId,
      contextualizedRequest: "Can I attend one day with a visiting teacher?",
      assessment: {
        availability: "assessed" as const,
        coverage: "unanswered" as const,
        reason: "insufficient_evidence" as const,
        unresolvedRequest: "One-day attendance permission",
        schemaVersion: 1,
      },
    };
    const [first, retry] = await Promise.all([repository.saveAssessment(input), repository.saveAssessment(input)]);
    expect(retry.id).toBe(first.id);
    expect(first.contextualizedRequest).toContain("visiting teacher");

    await repository.recordReaction({
      assessmentId: first.id, workspaceId, conversationId, reactionKey: "directive:1", directiveId: randomUUID(),
      targetMessageId: requestMessageId,
      evaluationState: "evaluated", evaluationIndex: 1, decision: "matched", reasonCode: "coverage_criteria_matched",
    });
    await repository.recordReaction({
      assessmentId: first.id, workspaceId, conversationId, reactionKey: "routine:1", routineId: randomUUID(),
      targetMessageId: requestMessageId,
      evaluationState: "suppressed", evaluationIndex: 2, decision: "suppressed", reasonCode: "active_routine",
    });
    expect((await repository.listByAssessmentId({ workspaceId, assessmentId: first.id })).map((entry) => entry.reactionKey))
      .toEqual(["directive:1", "routine:1"]);
    await repository.markInteractionEvaluated({ workspaceId, assessmentId: first.id });
    await expect(repository.findByRequestMessageId({ workspaceId, requestMessageId }))
      .resolves.toMatchObject({ interactionEvaluationState: "evaluated" });

    const otherWorkspaceId = randomUUID();
    const otherConversationId = randomUUID();
    const otherMessageId = randomUUID();
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [otherWorkspaceId, accountId, "Other coverage", `coverage-${otherWorkspaceId}`]);
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [otherConversationId, otherWorkspaceId]);
    await database.query("INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', $4)", [otherMessageId, otherConversationId, otherWorkspaceId, "Other request"]);
    await expect(repository.recordReaction({
      assessmentId: first.id,
      workspaceId: otherWorkspaceId,
      conversationId: otherConversationId,
      reactionKey: "cross-workspace",
      targetMessageId: otherMessageId,
      evaluationState: "evaluated",
      evaluationIndex: 0,
      decision: "matched",
      reasonCode: "should_not_cross_workspace",
    })).rejects.toThrow();

    await database.query("DELETE FROM messages WHERE id = $1", [requestMessageId]);
    await expect(repository.findByRequestMessageId({ workspaceId, requestMessageId })).resolves.toBeNull();
    await expect(repository.listByAssessmentId({ workspaceId, assessmentId: first.id })).resolves.toEqual([]);
  });

  it("rejects a request/conversation pair that is not durably scoped to the workspace", async () => {
    await expect(repository.saveAssessment({
      workspaceId,
      conversationId,
      requestMessageId: randomUUID(),
      originatingTurnId: randomUUID(),
      contextualizedRequest: "Invalid foreign key test",
      assessment: { availability: "failed" },
    })).rejects.toThrow();
  });

  it("rejects a real request message assigned to another conversation", async () => {
    const otherConversationId = randomUUID();
    const otherRequestMessageId = randomUUID();
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [otherConversationId, workspaceId]);
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', $4)",
      [otherRequestMessageId, otherConversationId, workspaceId, "A different request"],
    );
    await expect(repository.saveAssessment({
      workspaceId,
      conversationId,
      requestMessageId: otherRequestMessageId,
      originatingTurnId: otherRequestMessageId,
      contextualizedRequest: "Mismatched conversation",
      assessment: { availability: "failed" },
    })).rejects.toThrow();
  });

  it("rejects a reaction whose target conversation differs from its assessment", async () => {
    const assessmentRequestId = randomUUID();
    const targetConversationId = randomUUID();
    const targetMessageId = randomUUID();
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', $4)",
      [assessmentRequestId, conversationId, workspaceId, "Assessment request"],
    );
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [targetConversationId, workspaceId]);
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', $4)",
      [targetMessageId, targetConversationId, workspaceId, "Other conversation request"],
    );
    const assessment = await repository.saveAssessment({
      workspaceId,
      conversationId,
      requestMessageId: assessmentRequestId,
      originatingTurnId: assessmentRequestId,
      contextualizedRequest: "Assessment request",
      assessment: { availability: "failed" },
    });

    await expect(repository.recordReaction({
      assessmentId: assessment.id,
      workspaceId,
      conversationId: targetConversationId,
      reactionKey: "cross-conversation",
      targetMessageId,
      evaluationState: "evaluated",
      evaluationIndex: 0,
      decision: "matched",
      reasonCode: "must_not_cross_conversation",
    })).rejects.toThrow();
  });
});
