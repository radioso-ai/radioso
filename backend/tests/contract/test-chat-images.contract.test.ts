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
  type TestExecutionRunnerResult,
  type TestExecutionTurnPhotos,
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
const memoryTest = (
  agentId: string,
  workspaceId: string,
  bind: (input: { workspaceId: string; testExecutionId: string; claim: TestExecutionTurnPhotos["claim"] }) => Promise<void>,
  /** The photo switch the tested revision holds; undefined for one frozen before it was part of a revision. */
  testedPhotos: boolean | undefined,
) => {
  const executionId = randomUUID();
  const sideId = randomUUID();
  const history: TestExecutionHistoryEntry[] = [];
  const turns = new Map<string, { fingerprint: string; answer?: TestExecutionRunnerResult }>();
  const execution = (): TestExecution => ({
    id: executionId, workspaceId, agentId, mode: "single", generation: 1, state: "completed", testValues: [], skillEffects: "suppressed",
    sides: [{
      id: sideId, executionId, conversationId: randomUUID(), state: "ready", retryable: false, history: [...history], continuation: null,
      revision: { id: randomUUID(), snapshot: { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [], ...(testedPhotos === undefined ? {} : { visitorImagesEnabled: testedPhotos }) }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null },
    }],
    createdAt: new Date(0), seededTurnCount: 0,
  });
  const repository = {
    find: async (input: { executionId: string }) => (input.executionId === executionId ? execution() : null),
    claimTurn: async (input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) => {
      const attempt = { executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message, inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(Date.now() + 60_000), state: "running" as const };
      const known = turns.get(input.turnId);
      if (known) return known.fingerprint === input.inputFingerprint && known.answer ? { claims: [{ sideId, attempt, replay: known.answer }] } : "turn_conflict";
      if (input.photos) await bind({ workspaceId, testExecutionId: executionId, claim: input.photos.claim });
      turns.set(input.turnId, { fingerprint: input.inputFingerprint });
      history.push({ turnId: input.turnId, attemptId: input.attemptId, role: "user", content: input.message, createdAt: input.now, ...(input.photos ? { imageInput: input.photos.imageInput } : {}) });
      return { claims: [{ sideId, attempt }] };
    },
    complete: async (input: { turnId: string; result: TestExecutionRunnerResult }) => {
      turns.set(input.turnId, { ...turns.get(input.turnId)!, answer: input.result });
      return execution();
    },
    historyNamesImage: async (input: { executionId: string; imageId: string }) => (input.executionId === executionId
      ? history.some((entry) => entry.imageInput?.images.some((image) => image.id === input.imageId))
      : null),
    revisionPhotoSwitches: async (input: { executionId: string }) => (input.executionId === executionId ? [testedPhotos] : null),
    fail: async () => execution(),
  } as unknown as TestExecutionRepositoryPort;
  return { executionId, history, repository };
};

/**
 * A workspace whose default agent takes photos for visitors unless told otherwise (`visitorImagesEnabled`,
 * its setting, which an agent published before the switch was part of a revision follows), with Test
 * Chat's service over one in-memory test whose revision holds `testedPhotos`, the chat door's own
 * photo claim, and a runner that answers every turn.
 */
const testChatWorkspace = async (options: { visitorImagesEnabled?: boolean; testedPhotos?: boolean | undefined } = {}) => {
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
    repository: {
      find: (input: never) => test!.repository.find(input),
      claimTurn: (input: never) => test!.repository.claimTurn(input),
      complete: (input: never) => test!.repository.complete(input),
      fail: (input: never) => test!.repository.fail(input),
      historyNamesImage: (input: never) => test!.repository.historyNamesImage(input),
      revisionPhotoSwitches: (input: never) => test!.repository.revisionPhotoSwitches(input),
    } as unknown as TestExecutionRepositoryPort,
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
  test = memoryTest(agentId, operator.workspaceId, (input) => visitorImages.bind(input), "testedPhotos" in options ? options.testedPhotos : true);
  const executionId = test.executionId;
  const image = await photo();
  const upload = () => request(app).post(`/api/v1/agents/${agentId}/test-executions/${executionId}/images`).set(dashboard).attach("image", image, "photo.png");
  const uploadForVisitors = () => request(app).post(`/api/v1/assistant/images?agentId=${agentId}`).set(dashboard).attach("image", image, "photo.png");
  const send = (body: object) => request(app)
    .post(`/api/v1/agents/${agentId}/test-executions/${executionId}/messages`)
    .set(dashboard)
    .send({ executionGeneration: 1, turnId: randomUUID(), attemptId: randomUUID(), ...body });
  const view = (imageId: string) => request(app).get(`/api/v1/agents/${agentId}/test-executions/${executionId}/images/${imageId}`).set(dashboard);
  return { ...created, operator, dashboard, agentId, executionId, history: test.history, runs, upload, uploadForVisitors, send, view };
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

  it("takes photos for a test whose revision has them on before visitors get them, and sends them", async () => {
    const { upload, uploadForVisitors, send, runs } = await testChatWorkspace({ visitorImagesEnabled: false, testedPhotos: true });

    const uploaded = await upload().expect(201);
    await send({ message: "Like this", imageIds: [uploaded.body.id] }).expect(200);

    expect(runs).toEqual([`Like this\n<attached_photo index="1">${READING}</attached_photo>`]);
    expect((await uploadForVisitors()).body).toMatchObject({ error: { code: "visitor_images_unavailable" } });
  });

  it("takes no photo for a test whose revision has them off, though visitors can send them", async () => {
    const { upload } = await testChatWorkspace({ visitorImagesEnabled: true, testedPhotos: false });

    const refused = await upload();

    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: "visitor_images_unavailable" } });
  });

  it("follows the agent's setting for a tested revision frozen before the switch was part of one", async () => {
    const { upload } = await testChatWorkspace({ visitorImagesEnabled: false, testedPhotos: undefined });

    expect((await upload()).body).toMatchObject({ error: { code: "visitor_images_unavailable" } });
  });

  it("takes no photo for a test that is not this workspace's", async () => {
    const { app, agentId, dashboard } = await testChatWorkspace();

    const refused = await request(app).post(`/api/v1/agents/${agentId}/test-executions/${randomUUID()}/images`).set(dashboard).attach("image", await photo(), "photo.png");

    expect(refused.status).toBe(404);
  });

  it("replays a photo turn sent again with the same identity, rather than refusing its photos", async () => {
    const { upload, send, runs } = await testChatWorkspace();
    const uploaded = await upload().expect(201);
    const identity = { turnId: randomUUID(), attemptId: randomUUID() };
    await send({ message: "Something like this", imageIds: [uploaded.body.id], ...identity }).expect(200);

    const again = await send({ message: "Something like this", imageIds: [uploaded.body.id], ...identity });

    expect(again.status).toBe(200);
    expect(again.text).toContain("Here are three like it.");
    expect(runs).toHaveLength(1);
  });

  it("records each teammate view of a Test Chat photo against the test", async () => {
    const { upload, send, view, operator, executionId, dependencies } = await testChatWorkspace();
    const uploaded = await upload().expect(201);
    await send({ message: "Something like this", imageIds: [uploaded.body.id] }).expect(200);

    await view(uploaded.body.id as string).expect(200);

    const events = (dependencies.auditService as unknown as { events: Array<{ eventType: string; workspaceId?: string | null; metadata?: Record<string, unknown> }> }).events
      .filter((event) => event.eventType === "agent.test_execution.image_viewed");
    expect(events).toEqual([expect.objectContaining({
      workspaceId: operator.workspaceId,
      metadata: { testExecutionId: executionId, imageId: uploaded.body.id, actorUserId: operator.userId },
    })]);
  });

  it("shows no photo the test does not carry and the caller did not upload, and none to a machine credential", async () => {
    const { view, app, agentId, executionId, upload, send } = await testChatWorkspace();
    const uploaded = await upload().expect(201);
    await send({ message: "Like this", imageIds: [uploaded.body.id] }).expect(200);

    await view(randomUUID()).expect(404);
    await request(app).get(`/api/v1/agents/${agentId}/test-executions/${executionId}/images/${uploaded.body.id as string}`).set({ Authorization: "Bearer rk_not_a_session" }).expect(401);
  });
});
