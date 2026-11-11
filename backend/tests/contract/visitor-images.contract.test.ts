import request from "supertest";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import { VISITOR_IMAGE_LIMITS } from "../../src/modules/visitorImages/public.js";
import type { VisitorImageReader } from "../../src/modules/visitorImages/domain.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const photo = (format: "jpeg" | "png" | "webp" = "png"): Promise<Buffer> =>
  sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#a0522d" } })[format]().toBuffer();

const READING = "A stone farmhouse with a terracotta roof, possibly from the 1800s.";

/**
 * A workspace whose default agent takes photos (unless told otherwise), with its public link on,
 * and a way to open public sessions on it.
 */
const imageWorkspace = async (options: { visitorImagesEnabled?: boolean; reader?: VisitorImageReader } = {}) => {
  const reader: VisitorImageReader = options.reader ?? { read: vi.fn(async () => ({ kind: "read" as const, description: READING })) };
  const created = createTestApp({ visitorImageReader: reader });
  const { app } = created;
  const operator = await issueTestSession(app, `visitor-images-${Math.random().toString(36).slice(2)}@example.com`);
  const dashboard = adminSessionHeaders(operator);
  const settings = await request(app).put("/api/v1/settings/general").set(dashboard).send({ anonymousChatEnabled: true }).expect(200);
  const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  if (options.visitorImagesEnabled !== false) {
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ visitorImagesEnabled: true }).expect(200);
  }
  const visitor = async () => {
    const session = await request(app).post(`/api/v1/public/chat/${chatToken}/sessions`).send({ channel: "anonymous_link" }).expect(200);
    const headers = { "x-radioso-public-session": session.body.publicSessionToken as string };
    return {
      session: session.body as { acceptsImages: boolean; publicSessionToken: string },
      upload: (bytes: Buffer, field = "image") => request(app).post(`/api/v1/public/chat/${chatToken}/images`).set(headers).attach(field, bytes, "photo.png"),
      send: (body: object) => request(app).post(`/api/v1/public/chat/${chatToken}`).set(headers).send({ stream: false, ...body }),
      view: (imageId: string) => request(app).get(`/api/v1/public/chat/${chatToken}/images/${imageId}`).set(headers),
    };
  };
  /** A new API credential of the operator's, in the same workspace. */
  const credential = async () => {
    const issued = await created.dependencies.personalCredentialService.issue({
      accountId: operator.accountId,
      workspaceId: operator.workspaceId,
      userId: operator.userId,
      label: "Image test credential",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    return { Authorization: `Bearer ${issued.secret}` };
  };
  const auditEvents = (eventType: string) => (created.dependencies.auditService as unknown as {
    events: Array<{ eventType: string; workspaceId?: string | null; metadata?: Record<string, unknown> }>;
  }).events.filter((event) => event.eventType === eventType);
  return { ...created, operator, dashboard, agentId, chatToken, visitor, reader, credential, auditEvents };
};

describe("visitor image contract", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("tells the public chat whether the agent takes photos", async () => {
    const on = await imageWorkspace();
    const off = await imageWorkspace({ visitorImagesEnabled: false });

    expect((await on.visitor()).session.acceptsImages).toBe(true);
    expect((await off.visitor()).session.acceptsImages).toBe(false);
  });

  it("uploads a photo, reads it, and runs the visitor's message on its text and the reading", async () => {
    const { visitor, dependencies, operator, reader } = await imageWorkspace();
    const { upload, send } = await visitor();

    const uploaded = await upload(await photo()).expect(201);
    expect(uploaded.body).toEqual({ id: expect.any(String), readingStatus: "read" });
    expect(reader.read).toHaveBeenCalledWith(expect.objectContaining({ image: { mediaType: "image/jpeg", base64Data: expect.any(String) } }));

    const reply = await send({ message: "Something like this", imageIds: [uploaded.body.id] }).expect(200);

    const messages = await dependencies.messageRepository.listByConversationId(operator.workspaceId, reply.body.conversationId as string);
    const userMessage = messages.find((message) => message.role === "user")!;
    expect(userMessage.content).toBe(`Something like this\n<visitor_image index="1">${READING}</visitor_image>`);
    expect(userMessage.inputMetadata?.imageInput).toEqual({ typedText: "Something like this", images: [{ id: uploaded.body.id, reading: READING }] });
  });

  it("sends photos with no text, and shows them in the visitor's history with what they typed", async () => {
    const { visitor, chatToken, app } = await imageWorkspace();
    const { upload, send, session } = await visitor();
    const uploaded = await upload(await photo("webp")).expect(201);

    const reply = await send({ imageIds: [uploaded.body.id] }).expect(200);

    const history = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${reply.body.conversationId as string}`)
      .set("x-radioso-public-session", session.publicSessionToken)
      .expect(200);
    const sent = (history.body.messages as Array<{ role: string; inputMetadata?: { imageInput?: unknown } }>).find((message) => message.role === "user");
    expect(sent?.inputMetadata?.imageInput).toEqual({ typedText: "", images: [{ id: uploaded.body.id, reading: READING }] });
  });

  it("serves a photo to the session that uploaded it, as a sandboxed uncached JPEG, and to nobody else", async () => {
    const { visitor } = await imageWorkspace();
    const owner = await visitor();
    const stranger = await visitor();
    const uploaded = await owner.upload(await photo()).expect(201);

    const viewed = await owner.view(uploaded.body.id as string).expect(200);
    expect(viewed.headers["content-type"]).toBe("image/jpeg");
    expect(viewed.headers["cache-control"]).toBe("private, no-store");
    expect(viewed.headers["content-security-policy"]).toContain("sandbox");
    expect(viewed.headers["x-content-type-options"]).toBe("nosniff");
    expect((await sharp(viewed.body as Buffer).metadata()).width).toBe(VISITOR_IMAGE_LIMITS.maxLongSidePx);

    await stranger.view(uploaded.body.id as string).expect(404);
  });

  it("refuses a file that is not a JPEG, PNG or WebP with 415, whatever it was called", async () => {
    const { visitor } = await imageWorkspace();
    const { upload } = await visitor();

    const response = await upload(Buffer.from("GIF89a\u0001\u0000\u0001\u0000")).expect(415);

    expect(response.body.error.code).toBe("unsupported_image_type");
  });

  it("refuses an upload over the raw size cap with 413", async () => {
    const { visitor } = await imageWorkspace();
    const { upload } = await visitor();

    const response = await upload(Buffer.concat([await photo("jpeg"), Buffer.alloc(VISITOR_IMAGE_LIMITS.maxUploadBytes)])).expect(413);

    expect(response.body.error.code).toBe("image_too_large");
  });

  it("refuses an upload for an agent that does not take photos, before reading the body", async () => {
    const { visitor, reader } = await imageWorkspace({ visitorImagesEnabled: false });
    const { upload } = await visitor();

    const response = await upload(await photo()).expect(404);

    expect(response.body.error.code).toBe("visitor_images_unavailable");
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("refuses a photo field under any other name", async () => {
    const { visitor } = await imageWorkspace();
    const { upload } = await visitor();

    await upload(await photo(), "file").expect(400);
  });

  it("refuses to send another visitor's photo", async () => {
    const { visitor } = await imageWorkspace();
    const owner = await visitor();
    const stranger = await visitor();
    const uploaded = await owner.upload(await photo()).expect(201);

    const response = await stranger.send({ message: "Mine now", imageIds: [uploaded.body.id] }).expect(409);

    expect(response.body.error.code).toBe("visitor_image_unavailable");
  });

  it("refuses to send a photo a second time", async () => {
    const { visitor } = await imageWorkspace();
    const { upload, send } = await visitor();
    const uploaded = await upload(await photo()).expect(201);
    await send({ message: "First", imageIds: [uploaded.body.id] }).expect(200);

    const again = await send({ message: "Again", imageIds: [uploaded.body.id] }).expect(409);

    expect(again.body.error.code).toBe("visitor_image_unavailable");
  });

  it("refuses more than three photos, or the same one twice, in one message", async () => {
    const { visitor } = await imageWorkspace();
    const { send } = await visitor();
    const id = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";

    await send({ imageIds: [id, id] }).expect(400);
    await send({ imageIds: [id, "7d4f0a3b-2e5c-4c9f-8a1b-3b5d7f9c1e23", "8e5a1b4c-3f6d-4d0a-9b2c-4c6e8a0d2f34", "9f6b2c5d-4a7e-4e1b-8c3d-5d7f9b1e3a45"] }).expect(400);
  });

  it("uploads through the API for the credential that sends the chat, and shows the operator the photo", async () => {
    const { app, agentId, operator, dashboard, credential, auditEvents } = await imageWorkspace();
    const bearer = await credential();

    const uploaded = await request(app).post(`/api/v1/assistant/images?agentId=${agentId}`).set(bearer).attach("image", await photo(), "photo.png").expect(201);
    const reply = await request(app).post("/api/v1/assistant/chat").set(bearer)
      .send({ agentId, message: "Find me one like this", imageIds: [uploaded.body.id], stream: false })
      .expect(200);
    const conversationId = reply.body.conversationId as string;

    const viewed = await request(app)
      .get(`/api/v1/conversations/${conversationId}/images/${uploaded.body.id as string}`)
      .set(dashboard)
      .expect(200);
    expect(viewed.headers["content-type"]).toBe("image/jpeg");
    expect(auditEvents("conversation.image_viewed")).toEqual([
      expect.objectContaining({
        workspaceId: operator.workspaceId,
        metadata: { conversationId, imageId: uploaded.body.id, actorUserId: operator.userId },
      }),
    ]);

    // A machine credential sends photos; only a teammate in the dashboard views them.
    await request(app).get(`/api/v1/conversations/${conversationId}/images/${uploaded.body.id as string}`).set(bearer).expect(401);
  });

  it("refuses an API chat with photos and no agent id", async () => {
    const { app, credential } = await imageWorkspace();

    await request(app).post("/api/v1/assistant/chat").set(await credential())
      .send({ message: "x", imageIds: ["6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12"], stream: false })
      .expect(400);
  });

  it("refuses a photo uploaded by another credential of the same workspace", async () => {
    const { app, agentId, credential } = await imageWorkspace();
    const first = await credential();
    const second = await credential();

    const uploaded = await request(app).post(`/api/v1/assistant/images?agentId=${agentId}`).set(first).attach("image", await photo(), "photo.png").expect(201);

    await request(app).post("/api/v1/assistant/chat").set(second)
      .send({ agentId, message: "x", imageIds: [uploaded.body.id], stream: false })
      .expect(409);
  });
});
