import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TestExecutionRepository, type TestExecutionPhotoBinder } from "../../src/db/repositories/testExecutionRepository.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { createTestChatPhotoTurns } from "../../src/modules/chat/composition.js";
import { TestExecutionService, type TestExecutionEvent, type TrustedTestExecutionRunnerPort } from "../../src/modules/test-execution/testExecution.js";
import { PostgresVisitorImageStore, VisitorImageService, bindVisitorImageClaimIn } from "../../src/modules/visitorImages/composition.js";
import type { VisitorImageOwner } from "../../src/modules/visitorImages/domain.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const READING = "A stone farmhouse.";

describeDb("Test Chat photos on Postgres", () => {
  const accountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), revisionId = randomUUID();
  const operator: VisitorImageOwner = { kind: "user", id: randomUUID() };
  const snapshot = { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] };
  const revision: AgentRevision = { id: revisionId, snapshot, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null };
  let database: Database;
  let photoStore: PostgresVisitorImageStore;
  let visitorImages: VisitorImageService;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    photoStore = new PostgresVisitorImageStore(database.kysely);
    visitorImages = new VisitorImageService({
      store: photoStore,
      objects: { locate: vi.fn(), put: vi.fn(), get: vi.fn(), remove: vi.fn() },
      reader: { read: vi.fn() },
      audit: { viewed: vi.fn(), viewedInTest: vi.fn() },
      availability: { forAgent: async () => "available" },
      usage: { reserveAnswer: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "test", `test-chat-photos-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "test", `test-chat-photos-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspaceId, "test"]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [revisionId, agentId, workspaceId, JSON.stringify(snapshot)]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined); await database.close(); });

  /** A photo the operator uploaded and the agent read. */
  const upload = async (): Promise<string> => {
    const id = randomUUID();
    await photoStore.insert({
      id, workspaceId, agentId, owner: operator,
      object: { bucket: "local", objectPath: `workspaces/${workspaceId}/visitor-images/${id}`, generation: null },
      byteSize: 1_024, width: 1_600, height: 900, sha256: "a".repeat(64),
    });
    await photoStore.recordReading({ workspaceId, id, status: "read", reading: READING, readAt: new Date() });
    return id;
  };

  const photoRow = async (id: string) => (await database.query<{ test_execution_id: string | null; claim_id: string | null }>(
    "SELECT test_execution_id, claim_id FROM visitor_images WHERE id = $1", [id],
  ))[0];

  /** Test Chat's service over the real store, binding photos with the turn as composition does, and a runner that answers. */
  const testChat = (binder: TestExecutionPhotoBinder = (trx, input) => bindVisitorImageClaimIn(trx)({ ...input, boundAt: new Date() })) => {
    const repository = new TestExecutionRepository(database.kysely, binder);
    const stream = vi.fn<TrustedTestExecutionRunnerPort["stream"]>(async function* () {
      yield "Here are three like it.";
      return { answer: "Here are three like it.", messageId: randomUUID(), continuation: { version: 1 } };
    });
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: { get: vi.fn() },
      repository,
      runner: { stream },
      photos: createTestChatPhotoTurns(visitorImages),
      usageLimitPolicy: { reserveAnswer: async () => ({ commit: async () => undefined, release: async () => undefined }) },
      createId: randomUUID,
    });
    return { service, repository, stream };
  };

  const newTest = async (repository: TestExecutionRepository) => {
    const executionId = randomUUID(), sideId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: sideId, executionId, revision, conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
    return { executionId, sideId };
  };

  const drain = async (events: AsyncIterable<TestExecutionEvent>) => {
    const seen: TestExecutionEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  };

  const send = (executionId: string, imageIds: string[], identity = { turnId: randomUUID(), attemptId: randomUUID() }) => ({
    workspaceId, agentId, accountId: null, executionId, generation: 1, message: "Something like this", ...identity, photos: { ids: imageIds, owner: operator },
  });

  it("stores a photo turn and binds its photos to the test in the same transaction", async () => {
    const { service, repository } = testChat();
    const { executionId } = await newTest(repository);
    const image = await upload();

    await drain(service.streamMessage(send(executionId, [image])));

    expect(await photoRow(image)).toMatchObject({ test_execution_id: executionId });
    const stored = await repository.find({ workspaceId, agentId, executionId });
    expect(stored?.sides[0]?.history[0]).toMatchObject({ role: "user", imageInput: { typedText: "Something like this", images: [{ id: image, reading: READING }] } });
  });

  it("replays a completed photo turn sent again, claiming nothing", async () => {
    const { service, repository, stream } = testChat();
    const { executionId } = await newTest(repository);
    const image = await upload();
    const identity = { turnId: randomUUID(), attemptId: randomUUID() };
    await drain(service.streamMessage(send(executionId, [image], identity)));

    const replay = await drain(service.streamMessage(send(executionId, [image], identity)));

    expect(replay).toContainEqual(expect.objectContaining({ type: "side_completed", answer: "Here are three like it." }));
    expect(stream).toHaveBeenCalledTimes(1);
    expect(await photoRow(image)).toMatchObject({ test_execution_id: executionId });
  });

  it("refuses the same turn sent with fresh photos that read the same, which stay free to send", async () => {
    const { service, repository } = testChat();
    const { executionId } = await newTest(repository);
    const identity = { turnId: randomUUID(), attemptId: randomUUID() };
    await drain(service.streamMessage(send(executionId, [await upload()], identity)));
    const fresh = await upload();

    await expect(drain(service.streamMessage(send(executionId, [fresh], identity)))).rejects.toMatchObject({ statusCode: 409 });

    expect(await photoRow(fresh)).toEqual({ test_execution_id: null, claim_id: null });
  });

  it("stores nothing, leaves no side running, and lets the photos go when they cannot be bound", async () => {
    const { service, repository } = testChat(async () => { throw new Error("bind failed"); });
    const { executionId } = await newTest(repository);
    const image = await upload();
    const identity = { turnId: randomUUID(), attemptId: randomUUID() };

    await expect(drain(service.streamMessage(send(executionId, [image], identity)))).rejects.toThrow("bind failed");

    const stored = await repository.find({ workspaceId, agentId, executionId });
    expect(stored?.sides[0]).toMatchObject({ state: "ready", history: [] });
    expect(await database.query("SELECT 1 FROM agent_test_execution_turns WHERE execution_id = $1", [executionId])).toEqual([]);
    expect(await photoRow(image)).toEqual({ test_execution_id: null, claim_id: null });
    // The next message is not held back by a turn that never stored.
    const next = testChat();
    await drain(next.service.streamMessage(send(executionId, [image])));
    expect(await photoRow(image)).toMatchObject({ test_execution_id: executionId });
  });

  it("says whether a test's history names a photo, and nothing for another workspace's or agent's test", async () => {
    const { service, repository } = testChat();
    const { executionId } = await newTest(repository);
    const image = await upload();
    await drain(service.streamMessage(send(executionId, [image])));

    await expect(repository.historyNamesImage({ workspaceId, agentId, executionId, imageId: image })).resolves.toBe(true);
    await expect(repository.historyNamesImage({ workspaceId, agentId, executionId, imageId: randomUUID() })).resolves.toBe(false);
    await expect(repository.historyNamesImage({ workspaceId: randomUUID(), agentId, executionId, imageId: image })).resolves.toBeNull();
    await expect(repository.historyNamesImage({ workspaceId, agentId: randomUUID(), executionId, imageId: image })).resolves.toBeNull();
  });

  it("reads the photo switch each side's revision holds, and nothing for another agent's test", async () => {
    const { repository } = testChat();
    const { executionId } = await newTest(repository);
    const switchedId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [switchedId, agentId, workspaceId, JSON.stringify({ ...snapshot, visitorImagesEnabled: true })]);
    const switched = randomUUID();
    await repository.create({ id: switched, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: switched, sides: [{ id: randomUUID(), executionId: switched, revision: { ...revision, id: switchedId }, conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });

    await expect(repository.revisionPhotoSwitches({ workspaceId, agentId, executionId })).resolves.toEqual([{}]);
    await expect(repository.revisionPhotoSwitches({ workspaceId, agentId, executionId: switched })).resolves.toEqual([{ visitorImagesEnabled: true }]);
    await expect(repository.revisionPhotoSwitches({ workspaceId, agentId: randomUUID(), executionId })).resolves.toBeNull();
  });
});
