import { randomUUID } from "node:crypto";

import request from "supertest";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import { createTestChatPhotoTurns } from "../../src/modules/chat/composition.js";
import {
  TestExecutionService,
  type TestExecution,
  type TestExecutionHistoryEntry,
  type TestExecutionRepositoryPort,
  type TrustedTestExecutionRunnerPort,
} from "../../src/modules/test-execution/testExecution.js";
import type { VisitorImageService } from "../../src/modules/visitorImages/public.js";
import { NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const READING = "A stone farmhouse with a terracotta roof.";

const photo = (): Promise<Buffer> =>
  sharp({ create: { width: 1200, height: 900, channels: 3, background: "#a0522d" } }).png().toBuffer();

/**
 * One single test in memory, as the test-execution store keeps it: a turn's user entry, with its
 * photos, is stored when the turn is claimed, and its answer when the side completes.
 */
const memoryTest = (agentId: string, workspaceId: string) => {
  const executionId = randomUUID();
  const sideId = randomUUID();
  const history: TestExecutionHistoryEntry[] = [];
  const execution = (): TestExecution => ({
    id: executionId, workspaceId, agentId, mode: "single", generation: 1, state: "completed", testValues: [], skillEffects: "suppressed",
    sides: [{
      id: sideId, executionId, conversationId: randomUUID(), state: "ready", retryable: false, history: [...history], continuation: null,
      revision: { id: randomUUID(), snapshot: { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null },
    }],
    createdAt: new Date(0), seededTurnCount: 0,
  });
  const repository = {
    find: async (input: { executionId: string }) => (input.executionId === executionId ? execution() : null),
    claimTurn: async (input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) => {
      history.push({ turnId: input.turnId, attemptId: input.attemptId, role: "user", content: input.message, createdAt: input.now, ...(input.imageInput ? { imageInput: input.imageInput } : {}) });
      return { claims: [{ sideId, attempt: { executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message, inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(Date.now() + 60_000), state: "running" as const } }] };
    },
    complete: async () => execution(),
    fail: async () => execution(),
  } as unknown as TestExecutionRepositoryPort;
  return { executionId, history, repository };
};

/**
 * A workspace whose default agent takes photos unless told otherwise, with Test Chat's service
 * over one in-memory test, the chat door's own photo claim, and a runner that answers every turn.
 */
const testChatWorkspace = async (options: { visitorImagesEnabled?: boolean } = {}) => {
  let visitorImages: VisitorImageService | null = null;
  const runs: string[] = [];
  const runner: TrustedTestExecutionRunnerPort = {
    async *stream(input) {
      runs.push(input.message);
      yield "Here are three like it.";
      return { answer: "Here are three like it.", messageId: randomUUID(), continuation: { version: 1 } };
    },
  };
  let test: ReturnType<typeof memoryTest> | null = null;
  const testExecutionService = new TestExecutionService({
    revisions: { findRevision: vi.fn(), readDraftGeneration: vi.fn() },
    contextCatalog: { get: vi.fn() },
    repository: { find: (input: never) => test!.repository.find(input), claimTurn: (input: never) => test!.repository.claimTurn(input), complete: (input: never) => test!.repository.complete(input), fail: (input: never) => test!.repository.fail(input) } as unknown as TestExecutionRepositoryPort,
    runner,
    photos: { claim: (input) => createTestChatPhotoTurns(visitorImages!).claim(input) },
    usageLimitPolicy: new NoopUsageLimitPolicy(),
    createId: randomUUID,
  });
  const created = createTestApp({ testExecutionService, visitorImageReader: { read: vi.fn(async () => ({ kind: "read" as const, description: READING })) } });
  visitorImages = created.dependencies.visitorImages;
  const { app } = created;
  const operator = await issueTestSession(app, `test-chat-images-${Math.random().toString(36).slice(2)}@example.com`);
  const dashboard = adminSessionHeaders(operator);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  if (options.visitorImagesEnabled !== false) {
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ visitorImagesEnabled: true }).expect(200);
  }
  test = memoryTest(agentId, operator.workspaceId);
  const executionId = test.executionId;
  const image = await photo();
  const upload = () => request(app).post(`/api/v1/assistant/images?agentId=${agentId}`).set(dashboard).attach("image", image, "photo.png");
  const send = (body: object) => request(app)
    .post(`/api/v1/agents/${agentId}/test-executions/${executionId}/messages`)
    .set(dashboard)
    .send({ executionGeneration: 1, turnId: randomUUID(), attemptId: randomUUID(), ...body });
  const view = (imageId: string) => request(app).get(`/api/v1/agents/${agentId}/test-executions/${executionId}/images/${imageId}`).set(dashboard);
  return { ...created, operator, dashboard, agentId, executionId, history: test.history, runs, upload, send, view };
};

describe("Test Chat photos", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("runs the test's turn on what the operator typed and the agent's reading, keeps the photo with the transcript, and shows it back", async () => {
    const { upload, send, view, runs, history } = await testChatWorkspace();
    const uploaded = await upload().expect(201);

    const sent = await send({ message: "Something like this", imageIds: [uploaded.body.id] });

    expect(sent.status).toBe(200);
    expect(runs).toEqual([`Something like this\n<attached_photo index="1">${READING}</attached_photo>`]);
    expect(history[0]).toMatchObject({ role: "user", imageInput: { typedText: "Something like this", images: [{ id: uploaded.body.id, reading: READING }] } });
    const viewed = await view(uploaded.body.id as string).expect(200);
    expect(viewed.headers["content-type"]).toBe("image/jpeg");
    expect(viewed.headers["cache-control"]).toBe("private, no-store");
  });

  it("sends photos with no typed text", async () => {
    const { upload, send, runs } = await testChatWorkspace();
    const uploaded = await upload().expect(201);

    await send({ imageIds: [uploaded.body.id] }).expect(200);

    expect(runs).toEqual([`<attached_photo index="1">${READING}</attached_photo>`]);
  });

  it("refuses to send a photo a second time, whichever chat it was sent in", async () => {
    const { upload, send } = await testChatWorkspace();
    const uploaded = await upload().expect(201);
    await send({ message: "Like this", imageIds: [uploaded.body.id] }).expect(200);

    const again = await send({ message: "And this", imageIds: [uploaded.body.id] });

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "visitor_image_unavailable" } });
  });

  it("refuses a photo another caller of the workspace uploaded", async () => {
    const created = await testChatWorkspace();
    const issued = await created.dependencies.personalCredentialService.issue({
      accountId: created.operator.accountId,
      workspaceId: created.operator.workspaceId,
      userId: created.operator.userId,
      label: "Test Chat photo credential",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const theirs = await request(created.app).post(`/api/v1/assistant/images?agentId=${created.agentId}`).set({ Authorization: `Bearer ${issued.secret}` }).attach("image", await photo(), "photo.png").expect(201);

    const sent = await created.send({ message: "Like this", imageIds: [theirs.body.id] });

    expect(sent.status).toBe(409);
    expect(created.runs).toEqual([]);
  });

  it("takes no photo for a test while the agent takes none for visitors", async () => {
    const { upload } = await testChatWorkspace({ visitorImagesEnabled: false });

    const refused = await upload();

    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: "visitor_images_unavailable" } });
  });

  it("shows no photo the test does not carry and the caller did not upload, and none to a machine credential", async () => {
    const { view, app, agentId, executionId, upload, send } = await testChatWorkspace();
    const uploaded = await upload().expect(201);
    await send({ message: "Like this", imageIds: [uploaded.body.id] }).expect(200);

    await view(randomUUID()).expect(404);
    await request(app).get(`/api/v1/agents/${agentId}/test-executions/${executionId}/images/${uploaded.body.id as string}`).set({ Authorization: "Bearer rk_not_a_session" }).expect(401);
  });
});
