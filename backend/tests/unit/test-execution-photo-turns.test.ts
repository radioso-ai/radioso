import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import {
  TestExecutionService,
  type TestExecution,
  type TestExecutionEvent,
  type TestExecutionHistoryEntry,
  type TestExecutionPhotoTurn,
  type TestExecutionPhotoTurnsPort,
  type TestExecutionRepositoryPort,
  type TrustedTestExecutionRunnerPort,
} from "../../src/modules/test-execution/testExecution.js";
import { AppError } from "../../src/shared/domain/errors.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const executionId = "30000000-0000-4000-8000-000000000001";
const turnId = "60000000-0000-4000-8000-000000000001";
const attemptId = "60000000-0000-4000-8000-000000000002";
const sideIds = ["90000000-0000-4000-8000-000000000001", "90000000-0000-4000-8000-000000000002"];
const IMAGE = "70000000-0000-4000-8000-000000000001";
const OPERATOR = { kind: "user" as const, id: "a0000000-0000-4000-8000-000000000001" };

const revision: AgentRevision = {
  id: "40000000-0000-4000-8000-000000000001",
  snapshot: { customInstruction: "Answer as the draft.", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 2,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

const execution = (sideCount = 1, history: TestExecutionHistoryEntry[] = []): TestExecution => ({
  id: executionId,
  workspaceId,
  agentId,
  mode: sideCount === 1 ? "single" : "compare",
  generation: 3,
  state: "completed",
  testValues: [],
  skillEffects: "suppressed",
  sides: sideIds.slice(0, sideCount).map((id) => ({
    id, executionId, revision, conversationId: "50000000-0000-4000-8000-000000000001",
    state: "ready" as const, retryable: false, history, continuation: null,
  })),
  createdAt: new Date(0),
  seededTurnCount: 0,
});

const renderedTurn = "Something like this\n<attached_photo index=\"1\">A stone farmhouse.</attached_photo>";
const imageInput = { typedText: "Something like this", images: [{ id: IMAGE, reading: "A stone farmhouse." }] };

/** The photos of one send as the chat door claims them; records whether they were bound or let go. */
const photoPort = (options: { refuse?: AppError } = {}) => {
  const turn: TestExecutionPhotoTurn = { message: renderedTurn, imageInput, stored: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) };
  const port = {
    claim: vi.fn<TestExecutionPhotoTurnsPort["claim"]>(async () => {
      if (options.refuse) throw options.refuse;
      return turn;
    }),
  };
  return { port, turn };
};

const serviceOver = (current: TestExecution, options: { photos?: TestExecutionPhotoTurnsPort; claimTurn?: Awaited<ReturnType<TestExecutionRepositoryPort["claimTurn"]>>; runnerFails?: boolean } = {}) => {
  const claims: Array<Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]> = [];
  const repository = {
    find: vi.fn(async () => current),
    claimTurn: vi.fn(async (input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) => {
      claims.push(input);
      return options.claimTurn ?? {
        claims: input.sideIds.map((sideId) => ({
          sideId,
          attempt: {
            executionId: input.executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message,
            inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), state: "running" as const,
          },
        })),
      };
    }),
    complete: vi.fn(async () => ({ ...current, state: "completed" as const })),
    fail: vi.fn(async () => ({ ...current, state: "partial" as const })),
  } as unknown as TestExecutionRepositoryPort;
  const stream = vi.fn<TrustedTestExecutionRunnerPort["stream"]>(async function* () {
    if (options.runnerFails) throw new Error("provider down");
    yield "Here are three like it.";
    return { answer: "Here are three like it.", messageId: "80000000-0000-4000-8000-000000000001", continuation: { version: 1 } };
  });
  const service = new TestExecutionService({
    revisions: { findRevision: vi.fn(), readDraftGeneration: vi.fn() },
    contextCatalog: { get: vi.fn() },
    repository,
    runner: { stream },
    ...(options.photos ? { photos: options.photos } : {}),
    usageLimitPolicy: { reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => undefined), release: vi.fn(async () => undefined) })) },
    createId: () => "b0000000-0000-4000-8000-000000000001",
    now: () => new Date(1_000),
  });
  return { service, claims, stream, repository };
};

const drain = async (events: AsyncIterable<TestExecutionEvent>) => {
  const seen: TestExecutionEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

const send = (message: string, photos?: { ids: readonly string[]; owner: typeof OPERATOR }) => ({
  workspaceId, agentId, accountId: null, executionId, message, generation: 3, turnId, attemptId, ...(photos ? { photos } : {}),
});

describe("a Test Chat message with photos", () => {
  it("claims the photos for this test and its uploader, runs every side on the turn text with the readings, and keeps the photos with the stored turn", async () => {
    const { port, turn } = photoPort();
    const { service, claims, stream } = serviceOver(execution(2), { photos: port });

    const events = await drain(service.streamMessage(send(" Something like this ", { ids: [IMAGE], owner: OPERATOR })));

    expect(port.claim).toHaveBeenCalledWith({ workspaceId, agentId, executionId, message: " Something like this ", imageIds: [IMAGE], owner: OPERATOR });
    expect(claims[0]).toMatchObject({ message: renderedTurn, imageInput });
    expect(stream.mock.calls.map(([input]) => input.message)).toEqual([renderedTurn, renderedTurn]);
    expect(turn.stored).toHaveBeenCalledTimes(1);
    expect(turn.finish).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "side_completed")).toHaveLength(2);
  });

  it("binds the photos once the turn is stored and before any side runs", async () => {
    const { port, turn } = photoPort();
    const { service, repository, stream } = serviceOver(execution(), { photos: port });

    await drain(service.streamMessage(send("", { ids: [IMAGE], owner: OPERATOR })));

    const storedAt = vi.mocked(turn.stored).mock.invocationCallOrder[0];
    expect(storedAt).toBeGreaterThan(vi.mocked(repository.claimTurn).mock.invocationCallOrder[0]);
    expect(storedAt).toBeLessThan(stream.mock.invocationCallOrder[0]);
  });

  it("takes photos with no typed text", async () => {
    const { port } = photoPort();
    const { service, claims } = serviceOver(execution(), { photos: port });

    await drain(service.streamMessage(send("  ", { ids: [IMAGE], owner: OPERATOR })));

    expect(claims[0]?.message).toBe(renderedTurn);
  });

  it("lets the photos go when the test refuses the turn before storing it, so the operator can send them again", async () => {
    const { port, turn } = photoPort();
    const { service, stream } = serviceOver(execution(), { photos: port, claimTurn: "turn_in_progress" });

    await expect(drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })))).rejects.toMatchObject({ code: "test_turn_in_progress" });

    expect(turn.stored).not.toHaveBeenCalled();
    expect(turn.finish).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it("keeps the photos with the stored turn when its side fails afterwards", async () => {
    const { port, turn } = photoPort();
    const { service } = serviceOver(execution(), { photos: port, runnerFails: true });

    const events = await drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })));

    expect(events.some((event) => event.type === "side_failed")).toBe(true);
    expect(turn.stored).toHaveBeenCalledTimes(1);
  });

  it("passes on the refusal of a photo this uploader cannot send, storing no turn", async () => {
    const { port } = photoPort({ refuse: new AppError(409, "visitor_image_unavailable", "unavailable") });
    const { service, claims } = serviceOver(execution(), { photos: port });

    await expect(drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })))).rejects.toMatchObject({ code: "visitor_image_unavailable" });

    expect(claims).toHaveLength(0);
  });

  it("refuses photos where no photo store is wired, and a message with neither text nor photos", async () => {
    const { service, claims } = serviceOver(execution());

    await expect(drain(service.streamMessage(send("Hi", { ids: [IMAGE], owner: OPERATOR })))).rejects.toMatchObject({ statusCode: 400 });
    await expect(drain(service.streamMessage(send("   ")))).rejects.toMatchObject({ statusCode: 400 });
    expect(claims).toHaveLength(0);
  });

  it("leaves a message without photos as it was", async () => {
    const { port } = photoPort();
    const { service, claims } = serviceOver(execution(), { photos: port });

    await drain(service.streamMessage(send("Do you open on Sundays?")));

    expect(port.claim).not.toHaveBeenCalled();
    expect(claims[0]).toMatchObject({ message: "Do you open on Sundays?" });
    expect(claims[0]?.imageInput).toBeUndefined();
  });
});

describe("which photos a test's transcript names", () => {
  const userEntry: TestExecutionHistoryEntry = { turnId, attemptId, role: "user", content: renderedTurn, imageInput, createdAt: new Date(0) };

  it("names a photo one of its messages carried, and no other", async () => {
    const { service } = serviceOver(execution(1, [userEntry]));

    await expect(service.carriesImage({ workspaceId, agentId, executionId, imageId: IMAGE })).resolves.toBe(true);
    await expect(service.carriesImage({ workspaceId, agentId, executionId, imageId: "70000000-0000-4000-8000-000000000009" })).resolves.toBe(false);
  });
});
