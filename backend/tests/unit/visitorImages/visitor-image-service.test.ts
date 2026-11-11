import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { VisitorImageOwner, VisitorImageReader, VisitorImageReading } from "../../../src/modules/visitorImages/domain.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { VisitorImageService } from "../../../src/modules/visitorImages/services/visitorImageService.js";
import { InMemoryVisitorImageObjects, InMemoryVisitorImageStore } from "../../support/inMemoryVisitorImages.js";

const WORKSPACE = "8d2b8f0e-6a1e-4c1a-9a43-0c1b2b5f9a01";
const AGENT = "1f0e0c7c-2b8e-4a55-8e3b-7d8f7f0c8a11";
const CONVERSATION = "0c9e2a4b-6d8f-4a1c-8e3b-5f7d9b1c3e22";
const VISITOR: VisitorImageOwner = { kind: "public_session", id: "4b6d8f0a-2c4e-4f6a-8b0d-1e3f5a7c9e33" };
const STRANGER: VisitorImageOwner = { kind: "public_session", id: "9e7c5a3f-1d0b-4e8c-a6f4-2b0d8e6c4a44" };

const photo = (): Promise<Buffer> => sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#4a7a3a" } }).png().toBuffer();

const harness = (options: { reading?: VisitorImageReading; overPlan?: boolean } = {}) => {
  const store = new InMemoryVisitorImageStore();
  const reservation = { commit: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const usage = {
    reserveAnswer: vi.fn(async () => {
      if (options.overPlan) throw new AppError(429, "usage_limit_exceeded", "Usage limit exceeded");
      return reservation;
    }),
  };
  const objects = new InMemoryVisitorImageObjects();
  const reader: VisitorImageReader = {
    read: vi.fn(async () => options.reading ?? { kind: "read" as const, description: "A green field under a clear sky." }),
  };
  const audit = { viewed: vi.fn(async () => undefined) };
  const metrics = { incrementCounter: vi.fn() };
  const service = new VisitorImageService({
    store,
    objects,
    reader,
    audit,
    usage,
    metrics,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const upload = async (owner: VisitorImageOwner = VISITOR) => {
    const result = await service.upload({ workspaceId: WORKSPACE, agentId: AGENT, owner, bytes: await photo(), locale: "it", surface: "website_embed" });
    if (result.kind !== "accepted") throw new Error(`upload rejected: ${result.reason}`);
    return result;
  };
  return { service, store, objects, reader, audit, usage, reservation, metrics, upload };
};

const counted = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls.map(([name, options]) => `${name as string}:${JSON.stringify((options as { labels: unknown }).labels)}`);

describe("VisitorImageService.upload", () => {
  it("stores the re-encoded photo under the workspace, reads it with the agent's model, and keeps the reading", async () => {
    const { service, store, objects, reader, metrics } = harness();

    const result = await service.upload({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, bytes: await photo(), locale: "it", surface: "website_embed" });

    expect(result).toEqual({ kind: "accepted", id: expect.any(String), readingStatus: "read" });
    if (result.kind !== "accepted") return;
    const row = store.rows.get(result.id)!;
    expect(row).toMatchObject({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, width: 1600, height: 800, readingStatus: "read", reading: "A green field under a clear sky." });
    expect(row.object.objectPath).toBe(`workspaces/${WORKSPACE}/visitor-images/${result.id}`);
    const stored = objects.objects.get(row.object.objectPath)!;
    expect((await sharp(stored).metadata()).format).toBe("jpeg");
    expect(reader.read).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      imageId: result.id,
      image: { mediaType: "image/jpeg", base64Data: stored.toString("base64") },
      locale: "it",
      surface: "website_embed",
    });
    expect(counted(metrics)).toEqual([
      "visitor_image_uploads_total:{\"outcome\":\"accepted\"}",
      "visitor_image_readings_total:{\"outcome\":\"read\"}",
    ]);
  });

  it("keeps a photo the model could not read, as unread", async () => {
    const { upload, store, metrics } = harness({ reading: { kind: "unread", reason: "timeout" } });

    const result = await upload();

    expect(result.readingStatus).toBe("unread");
    expect(store.rows.get(result.id)).toMatchObject({ readingStatus: "unread", reading: null });
    expect(counted(metrics)).toContain("visitor_image_readings_total:{\"outcome\":\"unread\"}");
  });

  it("refuses what is not a photo it reads, storing and reading nothing", async () => {
    const { service, store, objects, reader, metrics } = harness();

    const result = await service.upload({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, bytes: Buffer.from("%PDF-1.7"), locale: null, surface: "api" });

    expect(result).toEqual({ kind: "rejected", reason: "unsupported_type" });
    expect(store.rows.size).toBe(0);
    expect(objects.objects.size).toBe(0);
    expect(reader.read).not.toHaveBeenCalled();
    expect(counted(metrics)).toEqual(["visitor_image_uploads_total:{\"outcome\":\"rejected_type\"}"]);
  });
});

describe("VisitorImageService upload against the plan", () => {
  it("reserves one answer for each reading, as a chat reply would, and keeps it once the photo is read", async () => {
    const { upload, usage, reservation } = harness();

    await upload();

    expect(usage.reserveAnswer).toHaveBeenCalledWith({ workspaceId: WORKSPACE, surface: "website_embed", usage: "conversation_reply" });
    expect(reservation.commit).toHaveBeenCalledTimes(1);
    expect(reservation.release).not.toHaveBeenCalled();
  });

  it("gives the answer back when the model could not read the photo", async () => {
    const { upload, reservation } = harness({ reading: { kind: "unread", reason: "timeout" } });

    await upload();

    expect(reservation.release).toHaveBeenCalledTimes(1);
    expect(reservation.commit).not.toHaveBeenCalled();
  });

  it("refuses the upload with the chat turn's error once the plan has no answers left, storing and reading nothing", async () => {
    const { service, store, objects, reader } = harness({ overPlan: true });

    await expect(service.upload({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, bytes: await photo(), locale: null, surface: "api" }))
      .rejects.toMatchObject({ statusCode: 429, code: "usage_limit_exceeded" });

    expect(store.rows.size).toBe(0);
    expect(objects.objects.size).toBe(0);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("spends no answer on a file it refuses", async () => {
    const { service, usage } = harness();

    await service.upload({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, bytes: Buffer.from("%PDF-1.7"), locale: null, surface: "api" });

    expect(usage.reserveAnswer).not.toHaveBeenCalled();
  });
});

describe("VisitorImageService claim, bind and release", () => {
  it("hands the door each photo's reading in the order the caller named them", async () => {
    const { service, upload } = harness();
    const first = await upload();
    const second = await upload();

    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [second.id, first.id] });

    expect(claim.images).toEqual([
      { id: second.id, reading: "A green field under a clear sky." },
      { id: first.id, reading: "A green field under a clear sky." },
    ]);
  });

  it("hands an unread photo over with no reading", async () => {
    const { service, upload } = harness({ reading: { kind: "unread", reason: "failed" } });
    const image = await upload();

    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });

    expect(claim.images).toEqual([{ id: image.id, reading: null }]);
  });

  it("refuses another owner's photo and claims none of the send's photos", async () => {
    const { service, upload } = harness();
    const mine = await upload();
    const theirs = await upload(STRANGER);

    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [mine.id, theirs.id] }))
      .rejects.toMatchObject({ statusCode: 409, code: "visitor_image_unavailable" });
    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [mine.id] })).resolves.toBeDefined();
  });

  it("refuses a photo uploaded for another agent, or one named twice", async () => {
    const { service, upload } = harness();
    const image = await upload();

    await expect(service.claim({ workspaceId: WORKSPACE, agentId: randomUUID(), owner: VISITOR, imageIds: [image.id] }))
      .rejects.toMatchObject({ code: "visitor_image_unavailable" });
    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id, image.id] }))
      .rejects.toMatchObject({ code: "visitor_image_unavailable" });
  });

  it("binds the photos to the message the door names, after which no send can use them again", async () => {
    const { service, store, upload } = harness();
    const image = await upload();
    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });
    const messageId = randomUUID();

    await service.bind({ workspaceId: WORKSPACE, claim, conversationId: CONVERSATION, messageId });

    expect(store.rows.get(image.id)).toMatchObject({ conversationId: CONVERSATION, messageId });
    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] }))
      .rejects.toMatchObject({ code: "visitor_image_unavailable" });
  });

  it("lets go of a claim no message took, so the caller can send the photos again", async () => {
    const { service, upload } = harness();
    const image = await upload();
    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });

    await service.release({ workspaceId: WORKSPACE, claim });

    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] })).resolves.toBeDefined();
  });

  it("never lets go of photos already bound to their message", async () => {
    const { service, store, upload } = harness();
    const image = await upload();
    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });
    const messageId = randomUUID();
    await service.bind({ workspaceId: WORKSPACE, claim, conversationId: CONVERSATION, messageId });

    await service.release({ workspaceId: WORKSPACE, claim });

    expect(store.rows.get(image.id)).toMatchObject({ conversationId: CONVERSATION, messageId });
  });

  it("passes a failure to bind on to the turn rather than leaving the photo unbound unnoticed", async () => {
    const { service, store, upload } = harness();
    const image = await upload();
    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });
    vi.spyOn(store, "bindClaim").mockRejectedValueOnce(new Error("connection reset"));

    await expect(service.bind({ workspaceId: WORKSPACE, claim, conversationId: CONVERSATION, messageId: randomUUID() })).rejects.toThrow("connection reset");
  });

  it("refuses a second send of a photo another send holds", async () => {
    const { service, upload } = harness();
    const image = await upload();
    await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });

    await expect(service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] }))
      .rejects.toMatchObject({ code: "visitor_image_unavailable" });
  });
});

describe("VisitorImageService reads", () => {
  it("serves a photo to its owner only", async () => {
    const { service, upload, objects, store } = harness();
    const image = await upload();
    const stored = objects.objects.get(store.rows.get(image.id)!.object.objectPath)!;

    expect(await service.readForOwner({ workspaceId: WORKSPACE, owner: VISITOR, imageId: image.id })).toEqual(stored);
    expect(await service.readForOwner({ workspaceId: WORKSPACE, owner: STRANGER, imageId: image.id })).toBeNull();
  });

  it("serves a conversation's photo to a teammate and records the view", async () => {
    const { service, upload, audit } = harness();
    const image = await upload();
    const claim = await service.claim({ workspaceId: WORKSPACE, agentId: AGENT, owner: VISITOR, imageIds: [image.id] });
    await service.bind({ workspaceId: WORKSPACE, claim, conversationId: CONVERSATION, messageId: randomUUID() });

    const bytes = await service.readInConversation({ workspaceId: WORKSPACE, conversationId: CONVERSATION, imageId: image.id, actorUserId: "user-1" });

    expect(bytes).toBeInstanceOf(Buffer);
    expect(audit.viewed).toHaveBeenCalledWith({ workspaceId: WORKSPACE, conversationId: CONVERSATION, imageId: image.id, actorUserId: "user-1" });
    expect(await service.readInConversation({ workspaceId: WORKSPACE, conversationId: randomUUID(), imageId: image.id, actorUserId: "user-1" })).toBeNull();
    expect(audit.viewed).toHaveBeenCalledTimes(1);
  });
});
