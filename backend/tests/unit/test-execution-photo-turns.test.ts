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
  type TestExecutionRunnerResult,
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
const FRESH_IMAGE = "70000000-0000-4000-8000-000000000002";
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
const claim = { claimId: "claim-1", images: [{ id: IMAGE, reading: "A stone farmhouse." }] };
const storedAnswer: TestExecutionRunnerResult = { answer: "Here are three like it.", messageId: "80000000-0000-4000-8000-000000000001", continuation: { version: 1 } };

/** The photos of one send as the chat door claims them; records whether they were let go. */
const photoPort = (options: { refuse?: AppError } = {}) => {
  const turn: TestExecutionPhotoTurn = { message: renderedTurn, imageInput, claim, release: vi.fn(async () => undefined) };
  const port = {
    claim: vi.fn<TestExecutionPhotoTurnsPort["claim"]>(async () => {
      if (options.refuse) throw options.refuse;
      return turn;
    }),
  };
  return { port, turn };
};

type ClaimInput = Parameters<TestExecutionRepositoryPort["claimTurn"]>[0];
type ClaimOutcome = Awaited<ReturnType<TestExecutionRepositoryPort["claimTurn"]>>;

const running = (input: ClaimInput) => ({
  claims: input.sideIds.map((sideId) => ({
    sideId,
    attempt: {
      executionId: input.executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message,
      inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), state: "running" as const,
    },
  })),
});

const replayed = (input: ClaimInput) => ({
  claims: running(input).claims.map((claimed) => ({ ...claimed, replay: storedAnswer })),
});

const serviceOver = (current: TestExecution, options: {
  photos?: TestExecutionPhotoTurnsPort;
  claimTurn?: (input: ClaimInput) => ClaimOutcome | Promise<ClaimOutcome>;
  runnerFails?: boolean;
  namesImage?: boolean | null;
} = {}) => {
  const claims: ClaimInput[] = [];
  const repository = {
    find: vi.fn(async () => current),
    claimTurn: vi.fn(async (input: ClaimInput) => {
      claims.push(input);
      return options.claimTurn ? options.claimTurn(input) : running(input);
    }),
    complete: vi.fn(async () => ({ ...current, state: "completed" as const })),
    fail: vi.fn(async () => ({ ...current, state: "partial" as const })),
    historyNamesImage: vi.fn(async () => (options.namesImage === undefined ? false : options.namesImage)),
    revisionPhotoSwitches: vi.fn(async () => current.sides.map((side) => side.revision.snapshot.visitorImagesEnabled)),
  } as unknown as TestExecutionRepositoryPort;
  const stream = vi.fn<TrustedTestExecutionRunnerPort["stream"]>(async function* () {
    if (options.runnerFails) throw new Error("provider down");
    yield storedAnswer.answer;
    return storedAnswer;
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

/** The user entry a stored photo turn left in the side's history. */
const storedPhotoTurn: TestExecutionHistoryEntry = { turnId, attemptId, role: "user", content: renderedTurn, imageInput, createdAt: new Date(0) };

describe("a Test Chat message with photos", () => {
  it("claims the photos for their uploader and hands them to the store with the turn, which every side runs on", async () => {
    const { port, turn } = photoPort();
    const { service, claims, stream } = serviceOver(execution(2), { photos: port });

    const events = await drain(service.streamMessage(send(" Something like this ", { ids: [IMAGE], owner: OPERATOR })));

    expect(port.claim).toHaveBeenCalledWith({ workspaceId, agentId, message: " Something like this ", imageIds: [IMAGE], owner: OPERATOR, revision: {} });
    expect(claims[0]).toMatchObject({ message: renderedTurn, photos: { imageInput, claim } });
    expect(stream.mock.calls.map(([input]) => input.message)).toEqual([renderedTurn, renderedTurn]);
    expect(turn.release).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "side_completed")).toHaveLength(2);
  });

  it("takes photos with no typed text", async () => {
    const { port } = photoPort();
    const { service, claims } = serviceOver(execution(), { photos: port });

    await drain(service.streamMessage(send("  ", { ids: [IMAGE], owner: OPERATOR })));

    expect(claims[0]?.message).toBe(renderedTurn);
  });

  it("names a photo turn by what was typed and which photos it carries, not by the readings", async () => {
    const { port } = photoPort();
    const { service, claims } = serviceOver(execution(), { photos: port });

    await drain(service.streamMessage(send(" Something like this ", { ids: [IMAGE], owner: OPERATOR })));

    expect(claims[0]?.inputFingerprint).toBe(JSON.stringify({ message: "Something like this", imageIds: [IMAGE] }));
  });

  it("lets the photos go when the test refuses the turn before storing it, so the operator can send them again", async () => {
    const { port, turn } = photoPort();
    const { service, stream } = serviceOver(execution(), { photos: port, claimTurn: () => "turn_in_progress" });

    await expect(drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })))).rejects.toMatchObject({ code: "test_turn_in_progress" });

    expect(turn.release).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it("lets the photos go when storing the turn fails, and stores nothing", async () => {
    const { port, turn } = photoPort();
    const { service, stream } = serviceOver(execution(), { photos: port, claimTurn: () => Promise.reject(new Error("connection reset")) });

    await expect(drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })))).rejects.toThrow("connection reset");

    expect(turn.release).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it("lets the photos go when the store answers with a turn it already had, which never took them", async () => {
    const { port, turn } = photoPort();
    const { service, stream } = serviceOver(execution(), { photos: port, claimTurn: replayed });

    await drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })));

    expect(turn.release).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it("keeps the photos with the stored turn when its side fails afterwards", async () => {
    const { port, turn } = photoPort();
    const { service } = serviceOver(execution(), { photos: port, runnerFails: true });

    const events = await drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })));

    expect(events.some((event) => event.type === "side_failed")).toBe(true);
    expect(turn.release).not.toHaveBeenCalled();
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
    expect(claims[0]).toMatchObject({ message: "Do you open on Sundays?", inputFingerprint: JSON.stringify("Do you open on Sundays?") });
    expect(claims[0]?.photos).toBeUndefined();
  });
});

describe("a repeat of a stored photo turn", () => {
  it("replays the stored answer and claims nothing", async () => {
    const { port, turn } = photoPort();
    const { service, claims, stream } = serviceOver(execution(1, [storedPhotoTurn]), { photos: port, claimTurn: replayed });

    const events = await drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })));

    expect(port.claim).not.toHaveBeenCalled();
    expect(turn.release).not.toHaveBeenCalled();
    expect(claims[0]).toMatchObject({ message: renderedTurn, inputFingerprint: JSON.stringify({ message: "Something like this", imageIds: [IMAGE] }) });
    expect(claims[0]?.photos).toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "side_completed", answer: storedAnswer.answer }));
  });

  it("refuses the same turn sent with other photos, claiming none of them", async () => {
    const { port } = photoPort();
    const { service, claims } = serviceOver(execution(1, [storedPhotoTurn]), {
      photos: port,
      claimTurn: (input) => (input.inputFingerprint === JSON.stringify({ message: "Something like this", imageIds: [IMAGE] }) ? replayed(input) : "turn_conflict"),
    });

    await expect(drain(service.streamMessage(send("Something like this", { ids: [FRESH_IMAGE], owner: OPERATOR })))).rejects.toMatchObject({ statusCode: 409 });

    expect(port.claim).not.toHaveBeenCalled();
    expect(claims[0]?.photos).toBeUndefined();
  });

  it("retries a failed photo turn on its stored text, named as it was sent", async () => {
    const { service, claims } = serviceOver(execution(1, [storedPhotoTurn]));

    await drain(service.streamRetry({ workspaceId, agentId, accountId: null, executionId, sideId: sideIds[0], generation: 3, turnId, attemptId: "60000000-0000-4000-8000-000000000003" }));

    expect(claims[0]).toMatchObject({ message: renderedTurn, inputFingerprint: JSON.stringify({ message: "Something like this", imageIds: [IMAGE] }), retry: true });
    expect(claims[0]?.photos).toBeUndefined();
  });
});

describe("which photos a test's transcript names", () => {
  it("asks the store, which reads only whether the test's history names the photo", async () => {
    const { service, repository } = serviceOver(execution(), { namesImage: true });

    await expect(service.namesImage({ workspaceId, agentId, executionId, imageId: IMAGE })).resolves.toBe(true);
    expect(repository.historyNamesImage).toHaveBeenCalledWith({ workspaceId, agentId, executionId, imageId: IMAGE });
    expect(repository.find).not.toHaveBeenCalled();
  });

  it("answers not-found for a test that is not this workspace's and agent's", async () => {
    const { service } = serviceOver(execution(), { namesImage: null });

    await expect(service.namesImage({ workspaceId, agentId, executionId, imageId: IMAGE })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("a test continued from a conversation with photos", () => {
  it("is labelled by what the visitor typed, never the readings its stored text carries", async () => {
    const create = vi.fn(async (input: Parameters<TestExecutionRepositoryPort["create"]>[0]) => ({ ...execution(), ...input, createdAt: new Date(0), state: "completed" as const, seededTurnCount: 1 }));
    const service = new TestExecutionService({
      revisions: { findRevision: vi.fn(async () => revision), readDraftGeneration: vi.fn() },
      contextCatalog: { get: vi.fn(async () => []) } as never,
      repository: { findByIdempotencyKey: vi.fn(async () => null), create } as unknown as TestExecutionRepositoryPort,
      runner: { stream: vi.fn() },
      seedSource: {
        loadSeed: vi.fn(async () => ({
          messages: [{ role: "user" as const, content: renderedTurn, imageInput, messageId: "m-1", createdAt: new Date(0) }],
          continuation: null,
        })),
      },
      usageLimitPolicy: { reserveAnswer: vi.fn() },
      createId: () => "b0000000-0000-4000-8000-000000000001",
    });

    await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revision.id], testValues: [], idempotencyKey: "start-1", seedConversationId: "c0000000-0000-4000-8000-000000000001" });

    expect(create.mock.calls[0]?.[0].seededSummary).toEqual({ turnCount: 1, firstMessage: "Something like this" });
  });
});

describe("whose photo switch decides a Test Chat message", () => {
  const withSwitches = (switches: ReadonlyArray<boolean | undefined>): TestExecution => {
    const current = execution(switches.length);
    return {
      ...current,
      sides: current.sides.map((side, index) => ({
        ...side,
        revision: { ...side.revision, snapshot: { ...side.revision.snapshot, ...(switches[index] === undefined ? {} : { visitorImagesEnabled: switches[index] }) } },
      })),
    };
  };

  it.each([
    ["the tested draft's", [true], { visitorImagesEnabled: true }],
    ["a tested version's that has photos off", [false], { visitorImagesEnabled: false }],
    ["both compared versions', which must both take photos", [true, false], { visitorImagesEnabled: false }],
    ["the agent's setting, for versions frozen before the switch was part of a revision", [undefined, true], {}],
  ] as const)("is %s", async (_name, switches, revision) => {
    const { port } = photoPort();
    const { service } = serviceOver(withSwitches(switches), { photos: port });

    await drain(service.streamMessage(send("Something like this", { ids: [IMAGE], owner: OPERATOR })));

    expect(port.claim).toHaveBeenCalledWith(expect.objectContaining({ revision }));
  });

  it("says, for an upload, whether every revision the test runs takes photos", async () => {
    const { service } = serviceOver(withSwitches([true, true]));

    await expect(service.photoSwitch({ workspaceId, agentId, executionId })).resolves.toEqual({ visitorImagesEnabled: true });
  });
});
