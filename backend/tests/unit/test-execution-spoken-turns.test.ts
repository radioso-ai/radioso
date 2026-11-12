import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import {
  TestExecutionService,
  type TestExecution,
  type TestExecutionEvent,
  type TestExecutionHistoryEntry,
  type TestExecutionRepositoryPort,
  type TrustedTestExecutionRunnerPort,
} from "../../src/modules/test-execution/testExecution.js";
import type { UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const executionId = "30000000-0000-4000-8000-000000000001";
const draftRevisionId = "40000000-0000-4000-8000-000000000001";

const revision = (id: string, customInstruction: string): AgentRevision => ({
  id,
  snapshot: { customInstruction, directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 2,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
});

const side = (id: string, history: TestExecutionHistoryEntry[] = []) => ({
  id,
  executionId,
  revision: revision(draftRevisionId, "Answer as the draft."),
  conversationId: "50000000-0000-4000-8000-000000000001",
  state: "ready" as const,
  retryable: false,
  history,
  continuation: null,
});

const greeting: TestExecutionHistoryEntry = {
  turnId: "60000000-0000-4000-8000-000000000001",
  attemptId: "60000000-0000-4000-8000-000000000002",
  role: "assistant",
  content: "Hi, I'm the draft. How can I help?",
  createdAt: new Date(0),
};

/** One execution in memory, with the claim and completion inputs the service sent. */
const memoryRepository = (execution: TestExecution | null) => {
  const claims: Array<Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]> = [];
  const completions: Array<Parameters<TestExecutionRepositoryPort["complete"]>[0]> = [];
  const repository = {
    find: vi.fn(async () => execution),
    claimTurn: vi.fn(async (input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) => {
      claims.push(input);
      return {
        claims: input.sideIds.map((sideId) => ({
          sideId,
          attempt: {
            executionId: input.executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message,
            inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), state: "running" as const,
          },
        })),
      };
    }),
    complete: vi.fn(async (input: Parameters<TestExecutionRepositoryPort["complete"]>[0]) => {
      completions.push(input);
      return { ...execution!, state: "completed" as const };
    }),
    fail: vi.fn(async () => ({ ...execution!, state: "partial" as const })),
  } as unknown as TestExecutionRepositoryPort;
  return { repository, claims, completions };
};

const ids = ["70000000-0000-4000-8000-000000000001", "70000000-0000-4000-8000-000000000002"];

const serviceOver = (execution: TestExecution | null, options: { usage?: Pick<UsageLimitPolicy, "reserveAnswer"> } = {}) => {
  const store = memoryRepository(execution);
  const stream = vi.fn<TrustedTestExecutionRunnerPort["stream"]>(async function* (input) {
    yield "Ahoy, ";
    return { answer: `Ahoy, ${input.candidateRevision.snapshot.customInstruction}`, messageId: "80000000-0000-4000-8000-000000000001", continuation: { version: 1 } };
  });
  let next = 0;
  const usage = options.usage ?? { reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => undefined), release: vi.fn(async () => undefined) })) };
  const service = new TestExecutionService({
    revisions: { findRevision: vi.fn(), readDraftGeneration: vi.fn() },
    contextCatalog: { get: vi.fn() },
    repository: store.repository,
    runner: { stream },
    usageLimitPolicy: usage,
    createId: () => ids[next++],
    now: () => new Date(1_000),
  });
  return { service, stream, usage, ...store };
};

const single = (history: TestExecutionHistoryEntry[] = []): TestExecution => ({
  id: executionId,
  workspaceId,
  agentId,
  mode: "single",
  generation: 3,
  state: "completed",
  testValues: [],
  skillEffects: "suppressed",
  sides: [side("90000000-0000-4000-8000-000000000001", history)],
  createdAt: new Date(0),
  seededTurnCount: 0,
});

const comparison = (): TestExecution => ({
  ...single(),
  mode: "compare",
  sides: [side("90000000-0000-4000-8000-000000000001"), side("90000000-0000-4000-8000-000000000002")],
});

const drain = async (events: AsyncIterable<TestExecutionEvent>) => {
  const seen: TestExecutionEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

const spokenTurn = { workspaceId, agentId, accountId: "a0000000-0000-4000-8000-000000000001", executionId, message: "Do you open on Sundays?" };

describe("a spoken Test Chat turn (#1536)", () => {
  it("runs on the test's revision with an identity it mints at the test's generation, and marks the turn spoken", async () => {
    const { service, stream, claims, completions } = serviceOver(single([greeting]));

    const events = await drain(service.streamSpokenMessage(spokenTurn));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      candidateRevision: expect.objectContaining({ id: draftRevisionId }),
      message: "Do you open on Sundays?",
      executionMode: "safe_test",
    }));
    expect(claims).toEqual([expect.objectContaining({ generation: 3, turnId: ids[0], attemptId: ids[1], message: "Do you open on Sundays?", spoken: true, retry: false })]);
    expect(completions).toEqual([expect.objectContaining({ turnId: ids[0], attemptId: ids[1], spoken: true })]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_delta", delta: "Ahoy, " }),
      expect.objectContaining({ type: "side_completed", answer: "Ahoy, Answer as the draft." }),
    ]));
  });

  it("charges the turn as a test run, never as a conversation reply", async () => {
    const reserveAnswer = vi.fn(async () => ({ commit: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }));
    const { service } = serviceOver(single(), { usage: { reserveAnswer } });

    await drain(service.streamSpokenMessage(spokenTurn));

    expect(reserveAnswer).toHaveBeenCalledWith({ accountId: spokenTurn.accountId, workspaceId, surface: "test_execution", usage: "test_run" });
  });

  it("refuses a comparison, which would answer twice", async () => {
    const { service, stream } = serviceOver(comparison());

    await expect(drain(service.streamSpokenMessage(spokenTurn))).rejects.toMatchObject({ statusCode: 409, code: "test_execution_not_single" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("refuses a test that is gone", async () => {
    const { service, stream } = serviceOver(null);

    await expect(drain(service.streamSpokenMessage(spokenTurn))).rejects.toMatchObject({ statusCode: 404 });
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("what a spoken session on a test opens with (#1536)", () => {
  it("is the test's own greeting while no message has been sent", async () => {
    const { service } = serviceOver(single([greeting]));

    await expect(service.spokenSessionOpening({ workspaceId, agentId, executionId })).resolves.toEqual({ greeting: "Hi, I'm the draft. How can I help?" });
  });

  it("is nothing once a message was sent, or when the test opened without a greeting", async () => {
    const sent: TestExecutionHistoryEntry = { ...greeting, role: "user", content: "Hello", turnId: "60000000-0000-4000-8000-000000000003" };

    await expect(serviceOver(single([greeting, sent])).service.spokenSessionOpening({ workspaceId, agentId, executionId })).resolves.toEqual({ greeting: null });
    await expect(serviceOver(single()).service.spokenSessionOpening({ workspaceId, agentId, executionId })).resolves.toEqual({ greeting: null });
  });

  it("refuses a comparison and a test that is gone", async () => {
    await expect(serviceOver(comparison()).service.spokenSessionOpening({ workspaceId, agentId, executionId })).rejects.toMatchObject({ statusCode: 409 });
    await expect(serviceOver(null).service.spokenSessionOpening({ workspaceId, agentId, executionId })).rejects.toMatchObject({ statusCode: 404 });
  });
});
