import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type { StoredReplyBlock } from "../../src/modules/chat/contracts/replyBlocks.js";
import {
  PostgresToolImageStore,
  ToolImageCapture,
  ToolImageEraser,
  ToolImageLookup,
  UnboundToolImageRetention,
  toolImageCaptureHandler,
} from "../../src/modules/toolImages/composition.js";
import type { ToolImageSource } from "../../src/modules/toolImages/contracts/index.js";
import type { ToolImageObject, ToolImageObjectStore } from "../../src/modules/toolImages/domain.js";
import { DefaultBackgroundJobQueue } from "../../src/shared/background-jobs/index.js";
import type { PublicBytesFetchResult } from "../../src/shared/infra/http/publicBytesFetch.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { seedConversations } from "./support/conversationSeed.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * A reply's cards from a skill's result, end to end on Postgres: the turn writes the block, the
 * picture rows and the capture job in one commit; the job copies the pictures; history replays the
 * block; a capture that outlived its claim changes nothing; the conversation's erasure and the
 * unbound sweep remove the rows and hand their objects to the deletion job.
 */
describeIntegration("cards from a skill's result (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const store = new PostgresToolImageStore(database.kysely, (trx) => new BackgroundJobRepository(trx));
  const objects = new Map<string, Buffer>();
  const objectStore: ToolImageObjectStore = {
    locate: ({ workspaceId, imageId, suffix }) => ({ bucket: "local", objectPath: `workspaces/${workspaceId}/tool-images/${imageId}-${suffix}`, generation: null }),
    put: async ({ workspaceId, imageId, suffix, bytes }) => {
      objects.set(`workspaces/${workspaceId}/tool-images/${imageId}-${suffix}`, bytes);
      return { sizeBytes: bytes.length };
    },
    remove: async (object: ToolImageObject) => {
      objects.delete(object.objectPath);
    },
  };
  let photo: Buffer;
  const fetchBytes = vi.fn(async (url: string): Promise<PublicBytesFetchResult> => {
    if (url.includes("expired")) return { kind: "failed", reason: "http_status", status: 403 };
    // A shop's CDN takes a moment, so a carousel's captures overlap.
    if (url.includes("cdn.shop.example")) await new Promise((resolve) => setTimeout(resolve, 50));
    return { kind: "fetched", bytes: photo, contentType: "image/jpeg", url };
  });
  let tags = 0;
  const capture = new ToolImageCapture({
    store,
    objects: objectStore,
    fetchBytes,
    renditionWidths: [320, 640],
    newCaptureTag: () => String(++tags).padStart(12, "0"),
  });
  const lookup = new ToolImageLookup({ store, capture });
  const persistence = new PostgresAssistantTurnPersistence(
    database.kysely,
    new ConversationActivityRepository(database.kysely),
    postgresWorkspaceEventRecorder, 60_000,
    undefined,
    undefined,
    undefined,
    new DefaultBackgroundJobQueue({ writer: new BackgroundJobRepository(database.kysely), wake: { requestDrain: async () => {} }, logger: { warn: vi.fn() } }),
    undefined,
    undefined,
    store,
  );
  const history = new ChatHistoryService(
    new ConversationRepository(database.kysely, postgresWorkspaceEventRecorder),
    new MessageRepository(database.kysely),
    new AuditEventRepository(database.kysely),
    new HistoryItemsRepository(database.kysely),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { forImage: (imageId) => ({ src: `https://api.example/api/v1/public/reply-images/${imageId}/640`, srcSet: "" }) },
  );
  const conversationId = randomUUID();
  const erasedConversationId = randomUUID();
  let workspaceId = "";

  beforeAll(async () => {
    await runAllTestMigrations(database);
    workspaceId = await seedConversations(database, [conversationId, erasedConversationId]);
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 80 } } }).jpeg().toBuffer();
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  const row = async (id: string) => (await database.query<{ status: string; message_id: string | null; source_url: string | null; failure_reason: string | null; width: number | null; renditions: Array<{ objectPath: string }> }>(
    "SELECT status, message_id, source_url, failure_reason, width, renditions FROM conversation_tool_images WHERE id = $1",
    [id],
  ))[0] ?? null;

  const jobs = async (kind: string) => database.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM background_jobs WHERE kind = $1 ORDER BY created_at",
    [kind],
  );

  const handedOffPaths = async () => (await jobs("tool_images.object_deletion"))
    .flatMap((job) => (job.payload.objects as Array<{ objectPath: string }>).map((object) => object.objectPath));

  const block = (imageIds: readonly string[]): StoredReplyBlock => ({
    type: "item_list",
    id: "b1",
    layout: "carousel",
    selection: "none",
    caption: "Flats in Mitte",
    origin: { kind: "skill_result", skillName: "search_listings" },
    items: imageIds.map((imageId, index) => ({
      key: `/structuredContent/${index}`,
      title: `Flat ${index + 1}`,
      image: { imageId, width: 640, height: 480, alt: `Flat ${index + 1}` },
      actions: [{ type: "open", url: `https://homes.example/listings/flat-${index + 1}` }],
    })),
  });

  const reply = async (conversation: string, sources: readonly ToolImageSource[]) => {
    const messageId = randomUUID();
    const receipt = await persistence.completeAssistantTurn({
      workspaceId,
      conversationId: conversation,
      assistantMessage: {
        id: messageId,
        conversationId: conversation,
        workspaceId,
        role: "assistant",
        content: "Two flats fit your budget.",
        metadata: { blocks: [block(sources.map((source) => source.imageId))] },
      },
      auditEvent: { eventType: "chat.answer", eventStatus: "success", workspaceId, metadata: {} },
      toolImages: sources,
    });
    return { messageId, receipt };
  };

  it("writes the block, its picture rows and their capture job with the reply, and replays the block from history", async () => {
    const first = randomUUID();
    const second = randomUUID();

    const { messageId, receipt } = await reply(conversationId, [
      { imageId: first, url: "https://img.homes.example/photos/flat-1.jpg?sig=secret" },
      { imageId: second, url: "https://img.homes.example/photos/flat-2.jpg" },
    ]);

    expect(await row(first)).toMatchObject({ status: "pending", message_id: messageId, source_url: "https://img.homes.example/photos/flat-1.jpg?sig=secret" });
    expect((await jobs("tool_images.capture")).map((job) => job.payload)).toContainEqual({ imageIds: [first, second] });
    expect(receipt.afterCommit).toBeTypeOf("function");

    const detail = await history.getConversation(workspaceId, conversationId, { limit: 50, offset: 0 });
    const replayed = detail.messages.find((message) => message.id === messageId);
    expect(replayed?.blocks?.[0]).toMatchObject({ layout: "carousel", items: [{ title: "Flat 1", image: { src: `https://api.example/api/v1/public/reply-images/${first}/640` } }, { title: "Flat 2" }] });
    expect(replayed?.blocks?.[0]).not.toHaveProperty("origin");

    // The job copies both pictures and clears the signed address.
    const handler = toolImageCaptureHandler({ capture, store });
    await handler.run({ imageIds: [first, second] }, { jobId: randomUUID(), attempt: 1, signal: new AbortController().signal });
    expect(await row(first)).toMatchObject({ status: "stored", source_url: null, width: 800 });
    expect(await lookup.find({ imageId: first, width: 320 })).toMatchObject({ kind: "found", object: { objectPath: expect.stringMatching(new RegExp(`/tool-images/${first}-w320-[0-9a-f]{12}$`)) } });
  });

  it("changes nothing for a capture whose claim was taken over, and deletes only that capture's copies", async () => {
    const image = randomUUID();
    await reply(conversationId, [{ imageId: image, url: "https://img.homes.example/photos/flat-3.jpg" }]);
    const claimedAt = new Date(Date.now() - 60_000);
    const stale = await store.claim(image, claimedAt);
    if (stale.kind !== "claimed") throw new Error("expected a claim");

    // Past the claim timeout another capture takes over and stores the picture.
    expect(await capture.capture(image, "job")).toBe("stored");
    const stored = await row(image);

    // The stale capture finishing writes nothing, and its own copies are the only ones handed off.
    const staleCopies = [{ bucket: "local", objectPath: `workspaces/${workspaceId}/tool-images/${image}-w640-ffffffffffff`, generation: null, width: 640, height: 480, sizeBytes: 1 }];
    expect(await store.markStored({ image: stale.image, width: 1, height: 1, sha256: "0".repeat(64), renditions: staleCopies })).toBe(false);
    await store.release({ image: stale.image, reason: "timeout", leftovers: [] });
    await store.markFailed({ image: stale.image, reason: "http_error" });

    expect(await row(image)).toEqual(stored);
    expect(await handedOffPaths()).toContain(staleCopies[0].objectPath);
    for (const rendition of stored.renditions) expect(await handedOffPaths()).not.toContain(rendition.objectPath);
  });

  it("copies a waiting picture on demand, and serves nothing for one that failed", async () => {
    const waiting = randomUUID();
    const expired = randomUUID();
    await reply(conversationId, [
      { imageId: waiting, url: "https://img.homes.example/photos/flat-4.jpg" },
      { imageId: expired, url: "https://img.homes.example/expired.jpg" },
    ]);

    expect(await lookup.find({ imageId: waiting, width: 640 })).toMatchObject({ kind: "found", object: { objectPath: expect.stringContaining(`/tool-images/${waiting}-w640-`) } });
    expect(await lookup.find({ imageId: expired, width: 640 })).toEqual({ kind: "miss", reason: "failed", retryable: false });
    expect(await row(expired)).toMatchObject({ status: "failed", failure_reason: "http_error", source_url: null });
    const fetchesBefore = fetchBytes.mock.calls.length;
    expect(await lookup.find({ imageId: expired, width: 640 })).toEqual({ kind: "miss", reason: "failed", retryable: false });
    expect(fetchBytes.mock.calls.length).toBe(fetchesBefore);
  });

  it("copies every picture of a carousel whose browser asks for all of them at once, more than the process captures at a time", async () => {
    const sources = Array.from({ length: 6 }, (_, index) => ({ imageId: randomUUID(), url: `https://cdn.shop.example/products/${index + 1}/thumbnail.webp` }));
    await reply(conversationId, sources);

    const served = await Promise.all(sources.map(({ imageId }) => lookup.find({ imageId, width: 320 })));

    expect(served.map((found) => (found.kind === "found" ? found.object.objectPath : found.reason)))
      .toEqual(sources.map(({ imageId }) => expect.stringContaining(`/tool-images/${imageId}-w320-`)));
    for (const { imageId } of sources) expect(await row(imageId)).toMatchObject({ status: "stored", source_url: null });
  });

  it("reads where a picture stands without claiming it: waiting, held by a fresh claim, waiting again once that claim is stale, stored, failed or missing", async () => {
    const [waiting, held, stale, stored, failed] = Array.from({ length: 5 }, () => randomUUID());
    await reply(conversationId, [waiting, held, stale, stored, failed].map((imageId) => ({ imageId, url: `https://img.homes.example/photos/${imageId}.jpg` })));
    const now = new Date();
    await store.claim(held, new Date(now.getTime() - 5_000));
    await store.claim(stale, new Date(now.getTime() - 31_000));
    await capture.capture(stored, "job");
    await database.query("UPDATE conversation_tool_images SET status = 'failed', failure_reason = 'http_error', source_url = NULL WHERE id = $1", [failed]);

    const states = await Promise.all([waiting, held, stale, stored, failed, randomUUID()].map((imageId) => store.peek(imageId, now)));

    expect(states).toEqual(["waiting", "held", "waiting", "stored", "failed", "missing"]);
    expect(await row(waiting)).toMatchObject({ status: "pending" });
  });

  it("erases a conversation's pictures and hands their objects to the deletion job", async () => {
    const image = randomUUID();
    await reply(erasedConversationId, [{ imageId: image, url: "https://img.homes.example/photos/flat-5.jpg" }]);
    await capture.capture(image, "job");
    const copies = (await row(image)).renditions.map((rendition) => rendition.objectPath);

    const erased = await database.kysely.transaction().execute(async (trx) =>
      new ToolImageEraser(trx, new BackgroundJobRepository(trx)).erase({ kind: "conversations", workspaceId, conversationIds: [erasedConversationId] }));

    expect(erased).toBe(1);
    expect(await row(image)).toBeNull();
    expect(await handedOffPaths()).toEqual(expect.arrayContaining(copies));
    expect(await lookup.find({ imageId: image, width: 640 })).toEqual({ kind: "miss", reason: "not_found", retryable: false });
  });

  it("sweeps a picture no message carries, a day after it was written", async () => {
    const old = randomUUID();
    const fresh = randomUUID();
    await database.kysely.transaction().execute(async (trx) => {
      await store.recordPreview(trx, { workspaceId, sources: [{ imageId: old, url: "https://img.homes.example/a.jpg" }, { imageId: fresh, url: "https://img.homes.example/b.jpg" }] });
    });
    await database.query("UPDATE conversation_tool_images SET created_at = now() - interval '25 hours' WHERE id = $1", [old]);

    const swept = await new UnboundToolImageRetention(database.kysely, (trx) => new BackgroundJobRepository(trx)).enforce({ now: new Date(), limit: 100 });

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toBeNull();
    expect(await row(fresh)).not.toBeNull();
  });
});
