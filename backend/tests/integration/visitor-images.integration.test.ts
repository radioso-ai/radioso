import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import {
  PostgresVisitorImageStore,
  UnboundVisitorImageRetention,
  VisitorImageEraser,
  bindVisitorImageClaimIn,
  VisitorImageExporter,
  visitorImageObjectDeletionHandler,
} from "../../src/modules/visitorImages/composition.js";
import type { NewVisitorImage, VisitorImageOwner } from "../../src/modules/visitorImages/domain.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { seedConversations } from "./support/conversationSeed.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const OWNER: VisitorImageOwner = { kind: "public_session", id: randomUUID() };

describeIntegration("visitor images on Postgres", () => {
  const database = new Database(integrationDatabaseUrl);
  const store = new PostgresVisitorImageStore(database.kysely);
  const messages = new MessageRepository(database.kysely);
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  let workspaceId = "";
  let agentId = "";

  beforeAll(async () => {
    await runAllTestMigrations(database);
    workspaceId = await seedConversations(database, [conversationId, otherConversationId]);
    agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id) VALUES ($1, $2)", [agentId, workspaceId]);
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  const upload = async (owner: VisitorImageOwner = OWNER, reading: string | null = "A stone farmhouse."): Promise<string> => {
    const id = randomUUID();
    const image: NewVisitorImage = {
      id,
      workspaceId,
      agentId,
      owner,
      object: { bucket: "local", objectPath: `workspaces/${workspaceId}/visitor-images/${id}`, generation: null },
      byteSize: 1_024,
      width: 1_600,
      height: 900,
      sha256: "a".repeat(64),
    };
    await store.insert(image);
    await store.recordReading({ workspaceId, id, status: reading ? "read" : "unread", reading, readAt: new Date() });
    return id;
  };

  /** What the chat door stores for a message with photos. */
  const carry = (imageIds: readonly string[], conversation = conversationId) => messages.create({
    conversationId: conversation,
    workspaceId,
    role: "user",
    content: "Something like this",
    inputMetadata: { method: "typed", imageInput: { typedText: "Something like this", images: imageIds.map((id) => ({ id, reading: null })) } },
  });

  const row = async (id: string) => (await database.query<{ conversation_id: string | null; message_id: string | null; claim_id: string | null }>(
    "SELECT conversation_id, message_id, claim_id FROM visitor_images WHERE id = $1",
    [id],
  ))[0] ?? null;

  const deletionJobs = async () => (await database.query<{ payload: { objects: Array<{ objectPath: string }> } }>(
    "SELECT payload FROM background_jobs WHERE kind = 'visitor_images.object_deletion'",
  )).flatMap((job) => job.payload.objects.map((object) => object.objectPath));

  it("claims a send's photos atomically for their owner, and binds them to exactly the message the door names", async () => {
    const first = await upload();
    const second = await upload(OWNER, null);
    const claimId = randomUUID();

    const claimed = await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [first, second], claimId, claimedAt: new Date() });
    expect(claimed?.map((image) => image.id).sort()).toEqual([first, second].sort());
    expect(claimed?.find((image) => image.id === second)).toMatchObject({ readingStatus: "unread", reading: null });

    // An earlier message naming the same photos is not the one the turn stored.
    await carry([first, second]);
    const message = await carry([first, second]);
    expect(await store.bindClaim({ workspaceId, claimId, conversationId, messageId: message.id, boundAt: new Date() })).toBe(2);
    expect(await store.bindClaim({ workspaceId, claimId, conversationId, messageId: message.id, boundAt: new Date() })).toBe(0);
    expect(await row(first)).toMatchObject({ conversation_id: conversationId, message_id: message.id });
    expect(await row(second)).toMatchObject({ conversation_id: conversationId, message_id: message.id });
    expect(await store.findInConversation({ workspaceId, conversationId, id: first })).toMatchObject({ id: first, readingStatus: "read", reading: "A stone farmhouse." });
  });

  it("claims none of a send's photos when any of them is another owner's or already claimed", async () => {
    const mine = await upload();
    const theirs = await upload({ kind: "public_session", id: randomUUID() });
    const held = await upload();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [held], claimId: randomUUID(), claimedAt: new Date() });

    expect(await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [mine, theirs], claimId: randomUUID(), claimedAt: new Date() })).toBeNull();
    expect(await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [mine, held], claimId: randomUUID(), claimedAt: new Date() })).toBeNull();
    expect((await row(mine))?.claim_id).toBeNull();
  });

  it("lets exactly one of two concurrent sends of a photo claim it", async () => {
    const image = await upload();

    const outcomes = await Promise.all([randomUUID(), randomUUID()].map((claimId) =>
      store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() })));

    expect(outcomes.filter((claimed) => claimed !== null)).toHaveLength(1);
  });

  it("lets go of a claim no message took, so the photos can be sent again, but never of a bound one", async () => {
    const image = await upload();
    const claimId = randomUUID();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() });

    expect(await store.releaseClaim({ workspaceId, claimId })).toBe(1);
    const retryClaimId = randomUUID();
    expect(await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId: retryClaimId, claimedAt: new Date() })).toHaveLength(1);

    const message = await carry([image]);
    await store.bindClaim({ workspaceId, claimId: retryClaimId, conversationId, messageId: message.id, boundAt: new Date() });
    expect(await store.releaseClaim({ workspaceId, claimId: retryClaimId })).toBe(0);
    expect(await row(image)).toMatchObject({ message_id: message.id, claim_id: retryClaimId });
  });

  it("leaves a photo unbound when its message is deleted on its own, rather than stranding its object", async () => {
    const image = await upload();
    const claimId = randomUUID();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() });
    const message = await carry([image]);
    await store.bindClaim({ workspaceId, claimId, conversationId, messageId: message.id, boundAt: new Date() });

    await messages.deleteUserMessage({ workspaceId, conversationId, messageId: message.id });

    expect(await row(image)).toMatchObject({ conversation_id: conversationId, message_id: null });
  });

  it("sweeps photos no message carries a day after upload, handing their objects to the deletion job", async () => {
    const stale = await upload();
    const fresh = await upload();
    const claimedJustNow = await upload();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [claimedJustNow], claimId: randomUUID(), claimedAt: new Date() });
    await database.query("UPDATE visitor_images SET created_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])", [[stale, claimedJustNow]]);
    const rule = new UnboundVisitorImageRetention(database.kysely, (trx) => new BackgroundJobRepository(trx));

    let removed = 0;
    for (let batch = await rule.enforce({ now: new Date(), limit: 50 }); batch > 0; batch = await rule.enforce({ now: new Date(), limit: 50 })) removed += batch;

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await row(stale)).toBeNull();
    expect(await row(fresh)).not.toBeNull();
    expect(await row(claimedJustNow)).not.toBeNull();
    expect(await deletionJobs()).toContain(`workspaces/${workspaceId}/visitor-images/${stale}`);
  });

  const photoHolder = async (id: string) => (await database.query<{ test_execution_id: string | null }>(
    "SELECT test_execution_id FROM visitor_images WHERE id = $1", [id],
  ))[0]?.test_execution_id ?? null;

  /** A Test Chat test of the agent, which keeps its transcript apart from conversations. */
  const testExecution = async (): Promise<string> => {
    const id = randomUUID();
    await database.query(
      "INSERT INTO agent_test_executions (id, workspace_id, agent_id, mode, state, test_values, idempotency_key) VALUES ($1, $2, $3, 'single', 'completed', '[]'::jsonb, $4)",
      [id, workspaceId, agentId, id],
    );
    return id;
  };

  it("keeps a photo a Test Chat test carries past the unbound sweep, then sweeps it once the test is deleted", async () => {
    const operator: VisitorImageOwner = { kind: "user", id: randomUUID() };
    const image = await upload(operator);
    const executionId = await testExecution();
    const claimId = randomUUID();
    await store.claim({ workspaceId, agentId, owner: operator, imageIds: [image], claimId, claimedAt: new Date() });

    expect(await store.bindClaim({ workspaceId, claimId, testExecutionId: executionId, boundAt: new Date() })).toBe(1);
    expect(await store.releaseClaim({ workspaceId, claimId })).toBe(0);
    expect(await store.findCarried({ workspaceId, agentId, id: image })).toMatchObject({ id: image, testExecutionId: executionId, conversationId: null, messageId: null });
    expect(await store.findCarried({ workspaceId, agentId: randomUUID(), id: image })).toBeNull();
    expect(await store.findInTest({ workspaceId, agentId, testExecutionId: executionId, id: image })).toMatchObject({ id: image });
    expect(await store.findInTest({ workspaceId, agentId, testExecutionId: await testExecution(), id: image })).toBeNull();
    await database.query("UPDATE visitor_images SET created_at = now() - interval '25 hours', claimed_at = now() - interval '25 hours' WHERE id = $1", [image]);
    const rule = new UnboundVisitorImageRetention(database.kysely, (trx) => new BackgroundJobRepository(trx));
    while (await rule.enforce({ now: new Date(), limit: 50 }) > 0) { /* drain */ }
    expect(await row(image)).not.toBeNull();

    await database.query("DELETE FROM agent_test_executions WHERE id = $1", [executionId]);
    while (await rule.enforce({ now: new Date(), limit: 50 }) > 0) { /* drain */ }

    expect(await row(image)).toBeNull();
    expect(await deletionJobs()).toContain(`workspaces/${workspaceId}/visitor-images/${image}`);
  });

  it("binds a claim inside the caller's transaction, and rolls it back when it binds fewer photos than were claimed", async () => {
    const image = await upload();
    const executionId = await testExecution();
    const claimId = randomUUID();
    const claimed = await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() });
    const claim = { claimId, images: claimed!.map((row) => ({ id: row.id, reading: row.reading })) };

    await expect(database.kysely.transaction().execute((trx) =>
      bindVisitorImageClaimIn(trx)({ workspaceId, claim: { ...claim, images: [...claim.images, { id: randomUUID(), reading: null }] }, testExecutionId: executionId, boundAt: new Date() })))
      .rejects.toThrow("visitor_image_bind_short");
    expect(await photoHolder(image)).toBeNull();

    await database.kysely.transaction().execute((trx) => bindVisitorImageClaimIn(trx)({ workspaceId, claim, testExecutionId: executionId, boundAt: new Date() }));
    expect(await photoHolder(image)).toBe(executionId);
  });

  it("never binds a photo to both a message and a test", async () => {
    const image = await upload();
    const executionId = await testExecution();
    const message = await carry([image]);

    await expect(database.query("UPDATE visitor_images SET conversation_id = $2, message_id = $3, test_execution_id = $4 WHERE id = $1", [image, conversationId, message.id, executionId]))
      .rejects.toThrow(/visitor_images_one_holder/);
  });

  it("erases a conversation's photos with it, handing their objects to the deletion job in the erasure's transaction", async () => {
    const image = await upload();
    const claimId = randomUUID();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() });
    const message = await carry([image], otherConversationId);
    await store.bindClaim({ workspaceId, claimId, conversationId: otherConversationId, messageId: message.id, boundAt: new Date() });

    const erased = await database.kysely.transaction().execute((trx) =>
      new VisitorImageEraser(trx, new BackgroundJobRepository(trx)).erase({ kind: "conversations", workspaceId, conversationIds: [otherConversationId] }));

    expect(erased).toBe(1);
    expect(await row(image)).toBeNull();
    expect(await deletionJobs()).toContain(`workspaces/${workspaceId}/visitor-images/${image}`);
  });

  it("deletes the objects a job names, and only visitor photos", async () => {
    const removed: string[] = [];
    const handler = visitorImageObjectDeletionHandler({ objects: { remove: async (object) => { removed.push(object.objectPath); } }, logger: { warn: () => undefined } });
    const imageId = randomUUID();
    const path = `workspaces/${workspaceId}/visitor-images/${imageId}`;

    const context = { jobId: "job-1", attempt: 1, signal: new AbortController().signal };
    await handler.run({ objects: [{ bucket: "local", objectPath: path, generation: null }] }, context);

    expect(removed).toEqual([path]);
    await expect(handler.run({ objects: [{ bucket: "local", objectPath: `workspaces/${workspaceId}/documents/${imageId}`, generation: null }] }, context)).rejects.toThrow();
    expect(removed).toEqual([path]);
  });

  it("exports each photo sent in the subject's conversations with its reading, never its bytes", async () => {
    const image = await upload();
    const claimId = randomUUID();
    await store.claim({ workspaceId, agentId, owner: OWNER, imageIds: [image], claimId, claimedAt: new Date() });
    const message = await carry([image]);
    await store.bindClaim({ workspaceId, claimId, conversationId, messageId: message.id, boundAt: new Date() });

    const exported = await new VisitorImageExporter(database.kysely).export({ workspaceId, conversationIds: [conversationId], visitorIds: [], verifiedCustomerIds: [] });

    expect(exported).toContainEqual(expect.objectContaining({
      imageId: image,
      conversationId,
      messageId: message.id,
      contentType: "image/jpeg",
      readingStatus: "read",
      reading: "A stone farmhouse.",
    }));
    expect(JSON.stringify(exported)).not.toContain("visitor-images/");
  });
});
