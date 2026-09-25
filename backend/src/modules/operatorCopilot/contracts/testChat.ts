import type { TestExecution, TestExecutionService } from "../../test-execution/public.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";

/**
 * Which immutable revision a Test Chat side ran. It is the first fact behind "why didn't this fire
 * in Test Chat": a draft candidate and a published version can behave differently for one message.
 */
export interface CopilotTestChatRevision {
  readonly id: string;
  readonly kind: "candidate" | "published";
  readonly versionNumber: number | null;
  readonly createdAt: string;
}

/**
 * One aligned turn on one side: the operator's message and the answer to it. A session's greeting
 * is a turn with no user message.
 */
export interface CopilotTestChatTurn {
  readonly turnId: string;
  readonly userMessage: string | null;
  readonly answer: { readonly messageId: string | null; readonly content: string } | null;
  /** `unanswered` is a seeded message that never had a reply in Test Chat. */
  readonly state: "completed" | "running" | "failed" | "unanswered";
  readonly failureCode: string | null;
  readonly createdAt: string;
  /** The runner's persisted turn trace envelope; tools bound and project it. */
  readonly turnTrace: unknown;
}

export interface CopilotTestChatSide {
  readonly sideId: string;
  readonly revision: CopilotTestChatRevision;
  readonly state: TestExecution["sides"][number]["state"];
}

interface CopilotTestChatSessionHeader {
  readonly testExecutionId: string;
  readonly mode: TestExecution["mode"];
  readonly state: TestExecution["state"];
  readonly skillEffects: TestExecution["skillEffects"];
  readonly createdAt: string;
}

export interface CopilotTestChatSessionSummary extends CopilotTestChatSessionHeader {
  readonly sides: ReadonlyArray<CopilotTestChatSide>;
  /** Turns the operator sent a message in; the greeting is not one. */
  readonly turnCount: number;
  readonly firstMessage: string | null;
}

export interface CopilotTestChatSession extends CopilotTestChatSessionHeader {
  readonly sides: ReadonlyArray<CopilotTestChatSide & { readonly turns: ReadonlyArray<CopilotTestChatTurn> }>;
}

export interface CopilotTestChatTurnDetail {
  readonly testExecutionId: string;
  readonly sideId: string;
  readonly revision: CopilotTestChatRevision;
  readonly turn: CopilotTestChatTurn;
}

export interface CopilotTestChatSendResult {
  readonly testExecutionId: string;
  /** True when this call started the session rather than continuing one. */
  readonly started: boolean;
  readonly sideId: string;
  readonly revision: CopilotTestChatRevision;
  readonly turnId: string;
  readonly outcome: "completed" | "failed";
  readonly failureCode: string | null;
  readonly answer: string | null;
  readonly messageId: string | null;
  readonly turnTrace: unknown;
}

interface CopilotTestChatScope {
  readonly workspaceId: string;
  readonly agentId: string;
}

export interface CopilotTestChatSendInput extends CopilotTestChatScope {
  readonly accountId: string;
  readonly operatorUserId: string;
  readonly message: string;
  /** Continues this session; without it a new single-revision session starts. */
  readonly testExecutionId?: string;
  /** The revision a new session starts on; without it the dashboard's default is used. */
  readonly revisionId?: string;
}

/**
 * The dashboard's Test Chat, in copilot vocabulary. Every session read or started here is the same
 * private, revision-pinned execution the dashboard lists.
 */
export interface CopilotTestChatPort {
  listSessions(input: CopilotTestChatScope & { readonly limit: number; readonly cursor?: string }): Promise<{
    readonly sessions: ReadonlyArray<CopilotTestChatSessionSummary>;
    readonly nextCursor: string | null;
  }>;
  readSession(input: CopilotTestChatScope & { readonly testExecutionId: string }): Promise<CopilotTestChatSession>;
  readTurn(input: CopilotTestChatScope & {
    readonly testExecutionId: string;
    readonly turnId: string;
    /** Defaults to the session's first side. */
    readonly sideId?: string;
  }): Promise<CopilotTestChatTurnDetail>;
  sendMessage(input: CopilotTestChatSendInput): Promise<CopilotTestChatSendResult>;
}

/** Test-execution's reads and the calls that drive one turn; the copilot makes exactly these. */
export type CopilotTestChatExecutionPort = Pick<TestExecutionService, "summaries" | "transcript" | "turn" | "start" | "message">;

export interface TestChatServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  readonly executions: CopilotTestChatExecutionPort;
  readonly createId: () => string;
}
