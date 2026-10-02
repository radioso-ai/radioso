import { AppError, badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import {
  isUsageLimitExceededError,
  USAGE_LIMIT_EXCEEDED_CODE,
  type UsageLimitPolicy,
  type UsageLimitReservation,
} from "../../shared/domain/usageLimitPolicy.js";
import type { AgentRevision } from "../agents/public.js";
import type { SkillEffectPolicy } from "../../shared/domain/turnExecutionMode.js";
import { clipAtGraphemeBoundary } from "../../shared/text/clipAtGraphemeBoundary.js";
import {
  freezeTestValues,
  type ContextVariableTestValueCatalogPort,
  type ContextVariableTestValueSelection,
  type FrozenTestValue,
  type TestValue,
} from "../context-variables/public.js";
import { findTranscriptTurn, readTranscript, settleSentTurn, type TestExecutionTranscript, type TestExecutionTurnRead } from "./testExecutionTurns.js";

// An attempt's lease must outlast the slowest legitimate turn, or a concurrent detail read
// marks a still-running attempt lease_expired and its result is discarded — and Retry then
// re-fires any real effect. A turn can chain several external tool steps, each up to the
// EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS cap (90s) plus a 10s connect, so this covers ~3 such
// steps. Cost of a long lease is only how long a genuinely crashed attempt stays "running"
// before it becomes retryable.
const DEFAULT_ATTEMPT_LEASE_MS = 300_000;

export type TestExecutionMode = "single" | "compare";
export type TestExecutionState = "running" | "partial" | "failed" | "completed";
export type TestExecutionSideState = "ready" | "running" | "failed" | "completed";

export interface TestExecutionSide {
  id: string;
  executionId: string;
  revision: AgentRevision;
  conversationId: string;
  state: TestExecutionSideState;
  retryable: boolean;
  history: readonly TestExecutionHistoryEntry[];
  continuation: unknown;
}

export interface TestExecutionHistoryEntry {
  turnId: string;
  role: "user" | "assistant";
  content: string;
  messageId?: string;
  /** Private, operator-only execution trace for inspecting this assistant turn. */
  turnTrace?: unknown;
  attemptId: string;
  createdAt: Date;
}

export interface TestExecution {
  id: string;
  workspaceId: string;
  agentId: string;
  mode: TestExecutionMode;
  generation: number;
  state: TestExecutionState;
  testValues: readonly FrozenTestValue[];
  /** Frozen at start, like `testValues`: whether this execution's turns may fire outward skill effects. */
  skillEffects: SkillEffectPolicy;
  sides: readonly TestExecutionSide[];
  createdAt: Date;
}

export interface TestExecutionAttempt {
  executionId: string;
  sideId: string;
  turnId: string;
  attemptId: string;
  message: string;
  inputFingerprint: string;
  fence: number;
  leaseExpiresAt: Date;
  state: "running" | "failed" | "completed";
  result?: TestExecutionRunnerResult;
}

/** Read-only durable fence evidence. Results and continuations stay side-owned. */
export interface TestExecutionAttemptRecord {
  executionId: string;
  sideId: string;
  turnId: string;
  attemptId: string;
  fence: number;
  state: "running" | "failed" | "completed";
  failureCode: string | null;
  leaseExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface TestExecutionDetail {
  execution: TestExecution;
  attempts: readonly TestExecutionAttemptRecord[];
}

export interface TestExecutionHistoryPage {
  executions: readonly TestExecutionHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TestExecutionHistorySide {
  id: string;
  revision: Pick<AgentRevision, "id" | "createdAt" | "publishedAt" | "publishedVersion">;
  conversationId: string;
  state: TestExecutionSideState;
  retryable: boolean;
}

/** List-safe projection: it intentionally excludes frozen inputs, transcripts, and continuations. */
export interface TestExecutionHistoryItem {
  id: string;
  mode: TestExecutionMode;
  generation: number;
  state: TestExecutionState;
  createdAt: Date;
  skillEffects: SkillEffectPolicy;
  sides: readonly TestExecutionHistorySide[];
}

/**
 * The most of a test's opening message any list shows; the store reads one more so a longer one shows
 * as clipped. A seeded test stores its label at this length plus one (migration 208 hard-codes 201), so
 * raising it needs those rows refilled, or their labels would read as whole.
 */
export const TEST_EXECUTION_LABEL_CHARS = 200;

/** A test's opening message as a list label: whole, or clipped on a character boundary and marked with an ellipsis. */
const testExecutionLabel = (firstMessage: string): { label: string; clipped: boolean } =>
  firstMessage.length <= TEST_EXECUTION_LABEL_CHARS
    ? { label: firstMessage, clipped: false }
    : { label: `${clipAtGraphemeBoundary(firstMessage, TEST_EXECUTION_LABEL_CHARS - 1)}…`, clipped: true };

/** What a seed copied in, recorded at start: its user messages count as turns, and the first labels the test. */
export interface TestExecutionSeededSummary {
  turnCount: number;
  firstMessage: string | null;
}

/** A listed execution with the facts that tell one session from another. Still no transcript. */
export interface TestExecutionSummary extends TestExecutionHistoryItem {
  /** Turns with a user message: those a seed copied in plus those the operator sent. A greeting is not one. */
  turnCount: number;
  /** The first of those messages with text, as a list label (`testExecutionLabel`); null until there is one. */
  firstMessage: string | null;
  /** Whether `firstMessage` was cut to fit the label. */
  firstMessageClipped: boolean;
}

interface TestExecutionSummaryPage extends Omit<TestExecutionHistoryPage, "executions"> {
  executions: readonly TestExecutionSummary[];
}

export interface TestExecutionClaim {
  sideId: string;
  attempt: TestExecutionAttempt;
  /** A completed provider result is delivery-replayed, never persisted a second time. */
  replay?: TestExecutionRunnerResult;
}

export type TestExecutionEvent =
  | { type: "side_started"; executionId: string; generation: number; turnId: string; attemptId: string; sideId: string }
  | { type: "message_delta"; executionId: string; generation: number; turnId: string; attemptId: string; sideId: string; delta: string }
  | { type: "side_completed"; executionId: string; generation: number; turnId: string; attemptId: string; sideId: string; messageId: string; turnTrace?: unknown }
  | { type: "side_failed"; executionId: string; generation: number; turnId: string; attemptId: string; sideId: string; code: string; retryable: boolean }
  | { type: "execution_partial"; executionId: string; generation: number; turnId: string; attemptId: string }
  | { type: "execution_completed"; executionId: string; generation: number; turnId: string; attemptId: string };

/** Immutable revision reader. It intentionally cannot read mutable authoring rows. */
interface TestExecutionRevisionReaderPort {
  findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null>;
  readDraftGeneration(input: { workspaceId: string; agentId: string }): Promise<number | null>;
}

/**
 * Chooses the revision a single test runs when the caller names none. Kept apart from the reader
 * because choosing may write: it can freeze a candidate from the saved draft.
 */
export interface TestExecutionDefaultRevisionPort {
  resolveDefault(input: { workspaceId: string; agentId: string }): Promise<{ revisionId: string; expectedDraftGeneration: number }>;
}

/** Catalog definitions remain live, while selection/configuration is frozen in a revision. */
/**
 * This is deliberately narrower than WorkbenchReplayRunner. The runtime adapter must use
 * the safe-test profile and export/import every engine continuation component; text history
 * is not a continuation substitute.
 */
export interface TrustedTestExecutionRunnerPort {
  bootstrap?(input: {
    workspaceId: string;
    agentId: string;
    candidateRevision: AgentRevision;
    accountId: string | null;
  }): Promise<{ answer: string; messageId: string } | null>;
  run(input: {
    workspaceId: string;
    agentId: string;
    candidateRevision: AgentRevision;
    conversationId: string;
    message: string;
    history: readonly TestExecutionHistoryEntry[];
    continuation: unknown;
    testValues: readonly FrozenTestValue[];
    executionMode: "safe_test";
    skillEffects: SkillEffectPolicy;
    accountId: string | null;
  }): Promise<TestExecutionRunnerResult>;
}

export interface TestExecutionRunnerResult {
  answer: string;
  messageId: string;
  /** The runner's presentation trace stays with the private execution evidence. */
  turnTrace?: unknown;
  /** Opaque, versioned runtime continuation owned by the runner adapter. */
  continuation: unknown;
}

/** One seeded message. The seed source decides what a thread contains; this module only orders it into turns. */
export interface TestExecutionSeedMessage {
  role: "user" | "assistant";
  content: string;
  messageId: string;
  createdAt: Date;
}

export interface TestExecutionSeed {
  messages: readonly TestExecutionSeedMessage[];
  /** Opaque runner continuation in the same shape the runner returns after a turn; null when there is nothing to resume. */
  continuation: unknown;
}

/**
 * Reads the thread and runtime continuation a single test side starts from. It answers null
 * when the conversation is not this workspace's and agent's, so this module never learns
 * whether a conversation exists elsewhere.
 */
export interface TestExecutionSeedSource {
  loadSeed(input: { workspaceId: string; agentId: string; conversationId: string }): Promise<TestExecutionSeed | null>;
}

export interface TestExecutionRepositoryPort {
  /** `idempotencyKey` fences a start: a repeated key for the same workspace/agent replays the execution it already created instead of starting a second one. */
  create(input: Omit<TestExecution, "createdAt" | "state"> & { state?: TestExecutionState; idempotencyKey: string; seededSummary?: TestExecutionSeededSummary }): Promise<TestExecution>;
  find(input: { workspaceId: string; agentId: string; executionId: string }): Promise<TestExecution | null>;
  /** Scoped by workspace alone: the read a caller with only an execution id, not yet an agent id, needs. Null for an id this workspace does not own. */
  findAgentId(input: { workspaceId: string; executionId: string }): Promise<string | null>;
  findByIdempotencyKey(input: { workspaceId: string; agentId: string; idempotencyKey: string }): Promise<TestExecution | null>;
  /** Self-heals a side stuck "running" past its lease (an abandoned attempt) into "failed, retryable". */
  recoverExpiredSides(input: { workspaceId: string; agentId: string; executionId: string; now: Date }): Promise<TestExecution | null>;
  retainSide(input: { workspaceId: string; agentId: string; executionId: string; sideId: string; retainedExecutionId: string; retainedSideId: string; retainedConversationId: string }): Promise<"not_found" | "not_comparison" | "unsettled" | TestExecution>;
  list(input: { workspaceId: string; agentId: string; limit: number; cursor?: string }): Promise<TestExecutionHistoryPage>;
  /**
   * Turn count and opening message per execution, from what its seed copied in plus the turns the
   * operator sent, never from its transcript; a greeting is not a turn. `firstMessage` is the raw
   * text cut to `firstMessageChars` characters.
   */
  summarizeTurns(input: { workspaceId: string; agentId: string; executionIds: readonly string[]; firstMessageChars: number }): Promise<ReadonlyMap<string, { turnCount: number; firstMessage: string | null }>>;
  listAttempts(input: { workspaceId: string; agentId: string; executionId: string }): Promise<readonly TestExecutionAttemptRecord[]>;
  /** Claims one aligned turn and every selected side in one short transaction. */
  /**
   * `turn_in_progress`: another turn is still running. A settled turn, a failed one included,
   * never blocks the next message; its failed side stays retryable until a later turn starts.
   */
  claimTurn(input: { workspaceId: string; agentId: string; executionId: string; sideIds: readonly string[]; generation: number; turnId: string; attemptId: string; message: string; inputFingerprint: string; now: Date; leaseMs: number; retry: boolean }): Promise<"generation_conflict" | "turn_in_progress" | "turn_conflict" | "retry_invalid" | "attempt_conflict" | { claims: readonly TestExecutionClaim[] }>;
  complete(input: { workspaceId: string; agentId: string; executionId: string; sideId: string; turnId: string; attemptId: string; fence: number; result: TestExecutionRunnerResult; now: Date }): Promise<"stale" | TestExecution>;
  fail(input: { workspaceId: string; agentId: string; executionId: string; sideId: string; turnId: string; attemptId: string; fence: number; code: string; now: Date }): Promise<"stale" | TestExecution>;
}

interface TestExecutionAuditPort {
  record(input: { workspaceId: string; accountId: string | null; eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, string | number | boolean | null> }): Promise<void>;
}

interface TestExecutionServiceOptions {
  revisions: TestExecutionRevisionReaderPort;
  defaultRevision?: TestExecutionDefaultRevisionPort;
  contextCatalog: ContextVariableTestValueCatalogPort;
  repository: TestExecutionRepositoryPort;
  runner: TrustedTestExecutionRunnerPort;
  seedSource?: TestExecutionSeedSource;
  usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer">;
  audit?: TestExecutionAuditPort;
  logger?: { warn(bindings: Record<string, unknown>, message: string): void };
  createId: () => string;
  now?: () => Date;
  leaseMs?: number;
}

const fingerprint = (message: string): string => JSON.stringify(message);

/** Typed so a caller (the dashboard, operator MCP) can tell "resend once it settles" from bad input. */
const TEST_TURN_IN_PROGRESS_CODE = "test_turn_in_progress";

/** An error's structural fields only: its message can carry visitor text, so it is never logged. */
const runnerFailureLogFields = (error: unknown): { errorType: string; errorCode?: string } => {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" ? { errorCode: code.slice(0, 80) } : {}),
  };
};

export class TestExecutionService {
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(private readonly options: TestExecutionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    // An attempt's lease must outlast the slowest legitimate turn, or a concurrent detail
    // read marks a still-running attempt `lease_expired` and its result is discarded. With
    // skill effects allowed, one tool step alone can take the full external-call bound
    // (30s by default) on top of planning and composition. The cost of a long lease is only
    // how long a crashed attempt stays "running" before it becomes retryable.
    this.leaseMs = options.leaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  }

  /** Without `revisionIds`, a single test starts on the agent's default revision. */
  async start(request: { workspaceId: string; agentId: string; accountId: string | null; mode: TestExecutionMode; revisionIds?: readonly string[]; testValues: readonly TestValue[]; expectedDraftGeneration?: number; idempotencyKey: string; skillEffects?: SkillEffectPolicy; seedConversationId?: string }): Promise<TestExecution> {
    // A retried or double-clicked start must never re-run the greeting bootstrap or mint a
    // second execution. Checked first, before any revision lookup or provider call.
    const replay = await this.options.repository.findByIdempotencyKey({ workspaceId: request.workspaceId, agentId: request.agentId, idempotencyKey: request.idempotencyKey });
    if (replay) return replay;
    const input = { ...request, ...(request.revisionIds ? { revisionIds: request.revisionIds } : await this.defaultSelection(request)) };
    // A seed continues one conversation forward; a comparison has no single thread to continue.
    // The HTTP schema refuses this combination too; this is defence-in-depth for non-HTTP callers.
    if (input.seedConversationId !== undefined && input.mode !== "single") {
      throw badRequest("A test execution seeded from a conversation runs a single revision.");
    }
    const expectedCount = input.mode === "single" ? 1 : 2;
    if (input.revisionIds.length !== expectedCount || new Set(input.revisionIds).size !== expectedCount) {
      throw badRequest("Test execution requires distinct immutable revision IDs for its selected mode.");
    }
    if (input.expectedDraftGeneration !== undefined) {
      const generation = await this.options.revisions.readDraftGeneration({ workspaceId: input.workspaceId, agentId: input.agentId });
      if (generation !== input.expectedDraftGeneration) throw conflict("Agent draft changed before the test execution started.");
    }
    const revisions = await Promise.all(input.revisionIds.map(async (revisionId) => {
      const revision = await this.options.revisions.findRevision({ workspaceId: input.workspaceId, agentId: input.agentId, revisionId });
      if (!revision) throw notFound("Agent revision is unavailable.");
      return structuredClone(revision);
    }));
    const testValues = await freezeTestValues({
      workspaceId: input.workspaceId,
      catalog: this.options.contextCatalog,
      selectedEnablements: revisions.map((revision): readonly ContextVariableTestValueSelection[] => revision.snapshot.contextVariableEnablements.map(({ variableId, enabled }) => ({ variableId, enabled }))),
      supplied: input.testValues,
    });
    const seed = input.seedConversationId === undefined
      ? null
      : await this.loadSeed({ workspaceId: input.workspaceId, agentId: input.agentId, conversationId: input.seedConversationId });
    // The seed is the opening, so a seeded side never receives a bootstrap greeting.
    const greetings = this.options.runner.bootstrap && !seed
      ? await Promise.all(revisions.map((revision) => this.options.runner.bootstrap!({
        workspaceId: input.workspaceId, agentId: input.agentId, candidateRevision: revision, accountId: input.accountId,
      })))
      : revisions.map(() => undefined);
    const executionId = this.options.createId();
    const skillEffects: SkillEffectPolicy = input.skillEffects ?? "suppressed";
    // The side's conversation id is always freshly minted: a seed is read from its source, never adopts it.
    const sides = revisions.map((revision, index): TestExecutionSide => ({
      id: this.options.createId(), executionId, revision, conversationId: this.options.createId(),
      state: "ready", retryable: false,
      history: seed ? this.seededHistory(seed.messages) : greetings[index] ? [{
        turnId: this.options.createId(), attemptId: this.options.createId(), role: "assistant",
        content: greetings[index].answer, messageId: greetings[index].messageId, createdAt: this.now(),
      }] : [],
      continuation: seed?.continuation ?? null,
    }));
    const execution = await this.options.repository.create({
      id: executionId, workspaceId: input.workspaceId, agentId: input.agentId, mode: input.mode,
      generation: 1, testValues, skillEffects, sides, idempotencyKey: input.idempotencyKey,
      ...(seed ? { seededSummary: this.seededSummary(seed.messages) } : {}),
    });
    await this.audit(input, "agent.test_execution.started", "success", {
      executionId, mode: input.mode, sideCount: sides.length, skillEffects,
      seedConversationId: input.seedConversationId ?? null,
      ...(seed ? { seededMessageCount: seed.messages.length } : {}),
    });
    return execution;
  }

  /** Fenced on the draft generation the default was chosen from, unless the caller fences on its own. */
  private async defaultSelection(input: { workspaceId: string; agentId: string; mode: TestExecutionMode; expectedDraftGeneration?: number }): Promise<{ revisionIds: readonly string[]; expectedDraftGeneration: number }> {
    if (input.mode !== "single") throw badRequest("A comparison test execution names both of its revisions.");
    if (!this.options.defaultRevision) throw badRequest("Starting a test execution without a revision is unavailable.");
    const selected = await this.options.defaultRevision.resolveDefault({ workspaceId: input.workspaceId, agentId: input.agentId });
    return { revisionIds: [selected.revisionId], expectedDraftGeneration: input.expectedDraftGeneration ?? selected.expectedDraftGeneration };
  }

  private async loadSeed(input: { workspaceId: string; agentId: string; conversationId: string }): Promise<TestExecutionSeed> {
    if (!this.options.seedSource) throw badRequest("Seeding a test execution from a conversation is unavailable.");
    const seed = await this.options.seedSource.loadSeed(input);
    // The same answer whether the conversation is missing, another workspace's, or another
    // agent's: its existence is never confirmed across those boundaries.
    if (!seed) throw notFound("Seed conversation is unavailable.");
    return seed;
  }

  /**
   * What a seed copied in, for the history list: each user message is a turn (see `seededHistory`),
   * and the first with any non-whitespace character labels the test. It is kept to one code point
   * more than a label shows, the same unit SQL `left` cuts in, so a longer one still reads as
   * clipped. Migration 208 backfills older tests the same way, except that its whitespace test is
   * Postgres's `[[:space:]]`, which can differ from JavaScript's `\s` on rare Unicode spaces.
   */
  private seededSummary(messages: readonly TestExecutionSeedMessage[]): TestExecutionSeededSummary {
    const userMessages = messages.filter((message) => message.role === "user");
    const first = userMessages.find((message) => /\S/u.test(message.content));
    return { turnCount: userMessages.length, firstMessage: first ? Array.from(first.content).slice(0, TEST_EXECUTION_LABEL_CHARS + 1).join("") : null };
  }

  /**
   * A durable turn is one user message and the assistant reply that answers it, so a seeded
   * user message and the reply that follows share a turn; a leading or consecutive assistant
   * message stands as its own turn. Seeded turns keep their source message ids.
   */
  private seededHistory(messages: readonly TestExecutionSeedMessage[]): TestExecutionHistoryEntry[] {
    let turn: { turnId: string; attemptId: string; answered: boolean } | null = null;
    return messages.map((message) => {
      if (!turn || message.role === "user" || turn.answered) {
        turn = { turnId: this.options.createId(), attemptId: this.options.createId(), answered: false };
      }
      if (message.role === "assistant") turn.answered = true;
      return {
        turnId: turn.turnId, attemptId: turn.attemptId, role: message.role,
        content: message.content, messageId: message.messageId, createdAt: message.createdAt,
      };
    });
  }

  /**
   * The effective agent for an id-scoped Test Chat call. The caller's own agentId, when given, is
   * used as-is: every read and write below is already scoped by (workspaceId, agentId,
   * executionId), so a mismatched id finds no row and fails not-found the same as any other wrong
   * id -- this is the "verify" half. Without one, resolves the execution's own owning agent by
   * workspace alone -- the "resolve" half, for a caller with a session id but not yet an agent id
   * (an operator MCP client continuing a Test Chat session by `testExecutionId`). An id this
   * workspace does not own resolves to nothing, so it fails not-found here too, rather than leaking
   * whether it exists elsewhere.
   */
  private async resolveAgentId(workspaceId: string, agentId: string | undefined, executionId: string): Promise<string> {
    if (agentId) return agentId;
    const resolved = await this.options.repository.findAgentId({ workspaceId, executionId });
    if (!resolved) throw notFound("Test execution is unavailable.");
    return resolved;
  }

  /** A list page with each execution's turn count and opening message, read in one projection rather than per execution. */
  async summaries(input: { workspaceId: string; agentId: string; limit: number; cursor?: string }): Promise<TestExecutionSummaryPage> {
    const page = await this.options.repository.list(input);
    const summaries = await this.options.repository.summarizeTurns({ firstMessageChars: TEST_EXECUTION_LABEL_CHARS + 1, workspaceId: input.workspaceId, agentId: input.agentId, executionIds: page.executions.map((item) => item.id) });
    return { ...page, executions: page.executions.map((item) => {
      const summary = summaries.get(item.id);
      const label = summary?.firstMessage ? testExecutionLabel(summary.firstMessage) : null;
      return { ...item, turnCount: summary?.turnCount ?? 0, firstMessage: label?.label ?? null, firstMessageClipped: label?.clipped ?? false };
    }) };
  }

  /**
   * The execution read as turns per side, after the same stuck-side self-heal `detail` applies.
   * `agentId` is resolved and verified by `resolveAgentId`, so a caller with only a session id
   * needs no separate lookup, and one that supplies a mismatched id gets the same not-found this
   * read already gives any other wrong id.
   */
  async transcript(input: { workspaceId: string; agentId?: string; executionId: string }): Promise<TestExecutionTranscript> {
    const agentId = await this.resolveAgentId(input.workspaceId, input.agentId, input.executionId);
    return readTranscript(await this.detail({ workspaceId: input.workspaceId, agentId, executionId: input.executionId }));
  }

  /** One turn on one side, the first side unless one is named, as the store holds it. */
  async turn(input: { workspaceId: string; agentId?: string; executionId: string; turnId: string; sideId?: string }): Promise<TestExecutionTurnRead> {
    return findTranscriptTurn(await this.transcript(input), input);
  }

  async detail(input: { workspaceId: string; agentId: string; executionId: string }): Promise<TestExecutionDetail> {
    const execution = await this.options.repository.find(input);
    if (!execution) throw notFound("Test execution is unavailable.");
    // A stuck side (e.g. a dropped SSE connection) self-heals on a plain read, the same terms
    // RevisionEvalRunService.get() reclaims a stuck revision-eval case on every poll.
    const current = execution.state === "running"
      ? (await this.options.repository.recoverExpiredSides({ ...input, now: this.now() })) ?? execution
      : execution;
    return { execution: current, attempts: await this.options.repository.listAttempts(input) };
  }

  /**
   * A comparison is immutable evidence. Continuing just one version therefore
   * creates a new one-side execution with that side's pinned conversation,
   * transcript, and runtime continuation rather than changing the comparison.
   */
  async retainSide(input: { workspaceId: string; agentId: string; accountId: string | null; executionId: string; sideId: string }): Promise<TestExecution> {
    const executionId = this.options.createId();
    const execution = await this.options.repository.retainSide({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      executionId: input.executionId,
      sideId: input.sideId,
      retainedExecutionId: executionId,
      retainedSideId: this.options.createId(),
      // Conversation IDs are unique per durable execution side. The serialized
      // continuation deliberately has no session ID, so the trusted runner
      // rebinds it to this new private conversation while retaining its state.
      retainedConversationId: this.options.createId(),
    });
    if (execution === "not_found") throw notFound("Test execution side is unavailable.");
    if (execution === "not_comparison") throw badRequest("Only a comparison version can be retained as a single test.");
    if (execution === "unsettled") throw conflict("A version can be closed after its current response is settled.");
    await this.audit(input, "agent.test_execution.side_retained", "success", { executionId, sourceExecutionId: input.executionId, sideCount: 1 });
    return execution;
  }

  async message(input: TestExecutionMessageInput): Promise<TestExecutionEvent[]> {
    const events: TestExecutionEvent[] = [];
    for await (const event of this.streamMessage(input)) events.push(event);
    return events;
  }

  /**
   * One turn without the stream: the settled outcome of this call's own attempt, on the first
   * side. `agentId` is resolved and verified by `resolveAgentId` before the turn is claimed, so a
   * caller continuing a session by id alone runs against that session's own agent.
   */
  async send(input: Omit<TestExecutionMessageInput, "agentId"> & { agentId?: string }): Promise<TestExecutionTurnRead> {
    const agentId = await this.resolveAgentId(input.workspaceId, input.agentId, input.executionId);
    const resolved = { ...input, agentId };
    const events = await this.message(resolved);
    return settleSentTurn(await this.turn({ workspaceId: resolved.workspaceId, agentId, executionId: resolved.executionId, turnId: resolved.turnId }), events);
  }

  async *streamMessage(input: TestExecutionMessageInput): AsyncGenerator<TestExecutionEvent> {
    if (!input.message.trim()) throw badRequest("Test message is required.");
    const execution = await this.requireExecution(input);
    const claimed = await this.claimTurn(execution, execution.sides.map((side) => side.id), input, false);
    yield* this.runClaims(execution, claimed, input);
  }

  async retry(input: TestExecutionRetryInput): Promise<TestExecutionEvent[]> {
    const events: TestExecutionEvent[] = [];
    for await (const event of this.streamRetry(input)) events.push(event);
    return events;
  }

  async *streamRetry(input: TestExecutionRetryInput): AsyncGenerator<TestExecutionEvent> {
    const execution = await this.requireExecution(input);
    const side = execution.sides.find((candidate) => candidate.id === input.sideId);
    if (!side) throw notFound("Test execution side is unavailable.");
    const latestUser = [...side.history].reverse().find((entry) => entry.role === "user" && entry.turnId === input.turnId);
    if (!latestUser) throw conflict("Retry must retain an existing failed turn input.");
    const claims = await this.claimTurn(execution, [side.id], { ...input, message: latestUser.content }, true);
    yield* this.runClaims(execution, claims, { ...input, message: latestUser.content });
  }

  private async requireExecution(input: { workspaceId: string; agentId: string; executionId: string }): Promise<TestExecution> {
    const execution = await this.options.repository.find(input);
    if (!execution) throw notFound("Test execution is unavailable.");
    return execution;
  }

  private async claimTurn(execution: TestExecution, sideIds: readonly string[], input: TestExecutionMessageInput, retry: boolean): Promise<readonly TestExecutionClaim[]> {
    const claimed = await this.options.repository.claimTurn({ ...input, sideIds, retry, inputFingerprint: fingerprint(input.message), now: this.now(), leaseMs: this.leaseMs });
    if (claimed === "generation_conflict") throw conflict("Test execution generation is stale.");
    if (claimed === "turn_in_progress") throw new AppError(409, TEST_TURN_IN_PROGRESS_CODE, "Another test turn is still running. Send the next message after it settles.");
    if (claimed === "turn_conflict") throw conflict("This test turn was already sent. Send the next message as a new turn.");
    if (claimed === "retry_invalid") throw conflict("Only the failed side of the original turn may be retried.");
    if (claimed === "attempt_conflict") throw conflict("A retry must use a new attempt identity unless replaying its completed response.");
    return claimed.claims;
  }

  private async *runClaims(execution: TestExecution, claims: readonly TestExecutionClaim[], identity: TestExecutionMessageInput): AsyncGenerator<TestExecutionEvent> {
    const sides = new Map(execution.sides.map((side) => [side.id, side]));
    for (const claim of claims) yield { type: "side_started", executionId: identity.executionId, generation: identity.generation, turnId: identity.turnId, attemptId: identity.attemptId, sideId: claim.sideId };
    const pending: Array<Promise<SideRunOutcome>> = [];
    for (const claim of claims) {
      // Attach the failure boundary while scheduling so a later race result cannot leave a side rejection unobserved.
      pending.push(this.runSide(execution, sides.get(claim.sideId)!, claim, identity).catch(() => {
        this.options.logger?.warn({ workspaceId: identity.workspaceId, executionId: identity.executionId, sideId: claim.sideId, turnId: identity.turnId, attemptId: identity.attemptId }, "Test execution side persistence failed");
        return { failed: true, events: [this.failedEvent(identity, claim.sideId, "persistence_failed", false)] };
      }));
    }
    while (pending.length > 0) {
      const resolved = await Promise.race(pending.map(async (item, index) => ({ index, outcome: await item })));
      void pending.splice(resolved.index, 1);
      const outcome = resolved.outcome;
      yield* outcome.events;
    }
    const durable = await this.options.repository.find({ workspaceId: identity.workspaceId, agentId: identity.agentId, executionId: identity.executionId });
    if (durable?.state === "completed") {
      yield { type: "execution_completed", executionId: identity.executionId, generation: identity.generation, turnId: identity.turnId, attemptId: identity.attemptId };
      await this.audit(identity, "agent.test_execution.completed", "success", { executionId: identity.executionId, turnId: identity.turnId, sideCount: claims.length });
    } else if (durable?.state === "partial" || durable?.state === "failed") {
      yield { type: "execution_partial", executionId: identity.executionId, generation: identity.generation, turnId: identity.turnId, attemptId: identity.attemptId };
      await this.audit(identity, "agent.test_execution.partial", "failure", { executionId: identity.executionId, turnId: identity.turnId, sideCount: claims.length });
    }
  }

  private async runSide(execution: TestExecution, side: TestExecutionSide, claim: TestExecutionClaim, identity: TestExecutionMessageInput): Promise<SideRunOutcome> {
    if (claim.replay) {
      return { failed: false, events: this.completedEvents(identity, side.id, claim.replay) };
    }
    let reservation: UsageLimitReservation | null = null;
    try {
      // Claims have completed and this is the last point before provider work. Replays return
      // above, so a lost SSE response is delivered without another answer reservation.
      reservation = await this.options.usageLimitPolicy.reserveAnswer({
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        surface: "test_execution",
        usage: "test_run",
      });
      const result = await this.options.runner.run({ workspaceId: identity.workspaceId, agentId: identity.agentId, candidateRevision: side.revision, conversationId: side.conversationId, message: claim.attempt.message, history: side.history, continuation: side.continuation, testValues: execution.testValues, executionMode: "safe_test", skillEffects: execution.skillEffects, accountId: identity.accountId });
      const stored = await this.options.repository.complete({ workspaceId: identity.workspaceId, agentId: identity.agentId, executionId: identity.executionId, sideId: side.id, turnId: identity.turnId, attemptId: identity.attemptId, fence: claim.attempt.fence, result, now: this.now() });
      await reservation.commit();
      return stored === "stale" ? { failed: true, events: [this.failedEvent(identity, side.id, "stale_attempt", false)] } : { failed: false, events: this.completedEvents(identity, side.id, result) };
    } catch (error) {
      // A reservation means the runner was dispatched or an after-dispatch persistence step
      // failed. That work remains chargeable even when no result could be delivered.
      await reservation?.commit();
      const code = isUsageLimitExceededError(error) ? USAGE_LIMIT_EXCEEDED_CODE : "runner_failed";
      if (code === "runner_failed") {
        this.options.logger?.warn({
          workspaceId: identity.workspaceId,
          agentId: identity.agentId,
          executionId: identity.executionId,
          sideId: side.id,
          turnId: identity.turnId,
          attemptId: identity.attemptId,
          failureCode: code,
          ...runnerFailureLogFields(error),
        }, "Test execution side failed");
      }
      const stored = await this.options.repository.fail({ workspaceId: identity.workspaceId, agentId: identity.agentId, executionId: identity.executionId, sideId: side.id, turnId: identity.turnId, attemptId: identity.attemptId, fence: claim.attempt.fence, code, now: this.now() });
      return { failed: true, events: [this.failedEvent(identity, side.id, stored === "stale" ? "stale_attempt" : code, stored !== "stale")] };
    }
  }

  private completedEvents(identity: TestExecutionMessageInput, sideId: string, result: TestExecutionRunnerResult): TestExecutionEvent[] {
    return [
      { type: "message_delta", executionId: identity.executionId, generation: identity.generation, turnId: identity.turnId, attemptId: identity.attemptId, sideId, delta: result.answer },
      {
        type: "side_completed",
        executionId: identity.executionId,
        generation: identity.generation,
        turnId: identity.turnId,
        attemptId: identity.attemptId,
        sideId,
        messageId: result.messageId,
        ...(result.turnTrace ? { turnTrace: result.turnTrace } : {}),
      },
    ];
  }

  private failedEvent(identity: TestExecutionMessageInput, sideId: string, code: string, retryable: boolean): TestExecutionEvent {
    return { type: "side_failed", executionId: identity.executionId, generation: identity.generation, turnId: identity.turnId, attemptId: identity.attemptId, sideId, code, retryable };
  }

  private async audit(input: { workspaceId: string; accountId: string | null }, eventType: string, eventStatus: "success" | "failure", metadata: Record<string, string | number | boolean | null>): Promise<void> {
    try { await this.options.audit?.record({ workspaceId: input.workspaceId, accountId: input.accountId, eventType, eventStatus, metadata }); }
    catch { this.options.logger?.warn({ workspaceId: input.workspaceId, executionId: metadata.executionId, eventType }, "Test execution audit recording failed"); }
  }
}

interface TestExecutionMessageInput { workspaceId: string; agentId: string; accountId: string | null; executionId: string; message: string; generation: number; turnId: string; attemptId: string; }
interface TestExecutionRetryInput extends Omit<TestExecutionMessageInput, "message"> { sideId: string; }
interface SideRunOutcome { failed: boolean; events: TestExecutionEvent[]; }
