import { notFound } from "../../shared/domain/errors.js";
import type { TestExecution, TestExecutionAttemptRecord, TestExecutionHistoryEntry, TestExecutionSide } from "./testExecution.js";

/**
 * One aligned turn on one side: the operator's message and the answer to it. A greeting is a turn
 * with no user message; `unanswered` is a seeded message that never had a reply in this execution.
 */
export interface TestExecutionTurn {
  turnId: string;
  userMessage: string | null;
  answer: { messageId: string | null; content: string } | null;
  state: "completed" | "running" | "failed" | "unanswered";
  /** The latest attempt's code, and only while the turn is failed. */
  failureCode: string | null;
  createdAt: Date;
  turnTrace: unknown;
}

export interface TestExecutionTranscriptSide extends Pick<TestExecutionSide, "id" | "revision" | "state"> {
  turns: readonly TestExecutionTurn[];
}

/** An execution read as turns. It carries no continuation, conversation id, or frozen sample values. */
export interface TestExecutionTranscript extends Pick<TestExecution, "id" | "mode" | "generation" | "state" | "skillEffects" | "createdAt"> {
  sides: readonly TestExecutionTranscriptSide[];
}

export interface TestExecutionTurnRead {
  executionId: string;
  side: Omit<TestExecutionTranscriptSide, "turns">;
  turn: TestExecutionTurn;
}

/** A retry supersedes an attempt with a higher fence, so the highest fence holds a turn's current state. */
const latestAttempts = (attempts: readonly TestExecutionAttemptRecord[], sideId: string): Map<string, TestExecutionAttemptRecord> => {
  const latest = new Map<string, TestExecutionAttemptRecord>();
  for (const attempt of attempts) {
    if (attempt.sideId !== sideId) continue;
    const current = latest.get(attempt.turnId);
    if (!current || attempt.fence > current.fence) latest.set(attempt.turnId, attempt);
  }
  return latest;
};

interface GroupedTurn { turnId: string; opening: TestExecutionHistoryEntry; user?: TestExecutionHistoryEntry; assistant?: TestExecutionHistoryEntry }

const groupTurns = (history: readonly TestExecutionHistoryEntry[]): GroupedTurn[] => {
  const turns = new Map<string, GroupedTurn>();
  for (const entry of history) {
    const turn = turns.get(entry.turnId) ?? { turnId: entry.turnId, opening: entry };
    if (entry.role === "user") turn.user ??= entry;
    else turn.assistant = entry;
    turns.set(entry.turnId, turn);
  }
  return [...turns.values()];
};

/** A side's history as turns. An answered turn is completed; otherwise its latest attempt says why not. */
export const readSideTurns = (side: Pick<TestExecutionSide, "id" | "history">, attempts: readonly TestExecutionAttemptRecord[]): TestExecutionTurn[] => {
  const latest = latestAttempts(attempts, side.id);
  return groupTurns(side.history).map(({ turnId, opening, user, assistant }) => {
    const attempt = latest.get(turnId);
    const state: TestExecutionTurn["state"] = assistant
      ? "completed"
      : attempt?.state === "running" ? "running" : attempt?.state === "failed" ? "failed" : "unanswered";
    return {
      turnId,
      userMessage: user?.content ?? null,
      answer: assistant ? { messageId: assistant.messageId ?? null, content: assistant.content } : null,
      state,
      failureCode: state === "failed" ? attempt?.failureCode ?? null : null,
      createdAt: opening.createdAt,
      turnTrace: assistant?.turnTrace,
    };
  });
};

export const readTranscript = ({ execution, attempts }: { execution: TestExecution; attempts: readonly TestExecutionAttemptRecord[] }): TestExecutionTranscript => ({
  id: execution.id,
  mode: execution.mode,
  generation: execution.generation,
  state: execution.state,
  skillEffects: execution.skillEffects,
  createdAt: execution.createdAt,
  sides: execution.sides.map((side) => ({ id: side.id, revision: side.revision, state: side.state, turns: readSideTurns(side, attempts) })),
});

/** One turn on one side; the first side unless one is named. */
export const findTranscriptTurn = (transcript: TestExecutionTranscript, input: { turnId: string; sideId?: string }): TestExecutionTurnRead => {
  const side = input.sideId ? transcript.sides.find((candidate) => candidate.id === input.sideId) : transcript.sides[0];
  if (!side) throw notFound("Test execution side is unavailable.");
  const turn = side.turns.find((candidate) => candidate.turnId === input.turnId);
  if (!turn) throw notFound("Test execution turn is unavailable.");
  return { executionId: transcript.id, side: { id: side.id, revision: side.revision, state: side.state }, turn };
};
