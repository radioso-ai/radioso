import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { createPostgresOwnershipTransferUnitOfWork } from "../../../src/app/composition/conversationOwnershipTransfers.js";
import { ActionRequestRepository } from "../../../src/db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationOwnershipService,
  type OwnershipActor,
} from "../../../src/modules/handoff/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres check that a transfer and the notice it owes the recipient commit together: an
// outbox failure rolls the transfer back, and the drain push goes out only once both are durable.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("conversation transfer with its notice (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const ownership = new ConversationOwnershipRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const danaId = randomUUID();
  const foxId = randomUUID();
  const dana: OwnershipActor = { accountId, workspaceId, userId: danaId };

  const outboxRows = async (conversationId: string) => database.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM routine_action_requests WHERE conversation_id = $1`,
    [conversationId],
  );

  const createService = (actionDrain: { requestDrain: () => Promise<void> }) => new ConversationOwnershipService({
    conversations: { findByIdAndWorkspaceId: async (id: string) => ({ id }) as ConversationRecord },
    ownership,
    transfers: createPostgresOwnershipTransferUnitOfWork({ db: database.kysely, actionDrain, logger: { warn: vi.fn() } }),
    operators: {
      find: async ({ userId }: { userId: string }) =>
        userId === foxId ? { userId: foxId, label: "Fox Mulder" } : userId === danaId ? { userId: danaId, label: "Dana Scully" } : null,
    },
    operatorIdentities: { resolve: async () => ({ userId: danaId, teammateLabel: "Dana Scully", replySignature: null }) },
    replies: { reply: vi.fn() },
    audit: { record: vi.fn(async () => undefined) },
  });

  const seedClaimedConversation = async (): Promise<{ conversationId: string; version: number }> => {
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, workspaceId]);
    const claim = await ownership.takeOver({ conversationId, workspaceId, accountId, userId: danaId, displayName: "Dana Scully" });
    if (!claim.ok) {
      throw new Error("seed claim failed");
    }
    return { conversationId, version: claim.record.version };
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Transfer Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Transfer Workspace", `route-${workspaceId}`],
    );
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      danaId, `dana-${danaId}@example.com`, "hash",
      foxId, `fox-${foxId}@example.com`, "hash",
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database.query(`DELETE FROM routine_action_requests WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[danaId, foxId]]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("commits the transfer with its notice, then pushes a drain that finds the row", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const rowsSeenByDrain: unknown[][] = [];
    const service = createService({
      requestDrain: async () => {
        rowsSeenByDrain.push(await outboxRows(conversationId));
      },
    });

    const result = await service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: version });

    expect(result).toMatchObject({ ok: true, changed: true, record: { ownerUserId: foxId, version: version + 1 } });
    expect(rowsSeenByDrain).toEqual([[{
      type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
      payload: { recipientUserId: foxId, transferredByUserId: danaId, ownershipVersion: version + 1 },
    }]]);
  });

  it("rolls the transfer back when its notice cannot be queued", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const requestDrain = vi.fn(async () => undefined);
    vi.spyOn(ActionRequestRepository.prototype, "enqueue").mockRejectedValueOnce(new Error("outbox unavailable"));
    const service = createService({ requestDrain });

    await expect(service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: version }))
      .rejects.toThrow("outbox unavailable");

    await expect(ownership.load(conversationId)).resolves.toMatchObject({ ownerUserId: danaId, version });
    await expect(outboxRows(conversationId)).resolves.toEqual([]);
    expect(requestDrain).not.toHaveBeenCalled();
  });

  it("queues nothing and pushes no drain when a teammate takes the conversation themselves", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const requestDrain = vi.fn(async () => undefined);
    const service = createService({ requestDrain });

    const result = await service.transfer({ ...dana, userId: foxId }, { conversationId, toUserId: foxId, expectedVersion: version });

    expect(result).toMatchObject({ ok: true, changed: true, record: { ownerUserId: foxId } });
    await expect(outboxRows(conversationId)).resolves.toEqual([]);
    expect(requestDrain).not.toHaveBeenCalled();
  });
});
