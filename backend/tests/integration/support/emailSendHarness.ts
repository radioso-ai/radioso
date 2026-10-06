import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";

import { createConversationActivityComposition } from "../../../src/app/composition/conversationActivity.js";
import { createPostgresOwnershipChangeUnitOfWork } from "../../../src/app/composition/conversationOwnershipChanges.js";
import { createPostgresOwnershipReplyUnitOfWork } from "../../../src/app/composition/conversationOwnershipReplies.js";
import { createEmailChannelComposition, createPostgresDeliveryFailures } from "../../../src/app/composition/emailChannel.js";
import { createPostgresHeldReplyUnitOfWork, type HeldReplyChannelRegistration } from "../../../src/app/composition/heldReplyUnitOfWork.js";
import { createTeammateLabelReader } from "../../../src/app/composition/teammateLabelReader.js";
import { parseEmailChannelConfig } from "../../../src/app/config/env.js";
import { createErrorHandler } from "../../../src/app/http/middleware/errorHandler.js";
import type { WorkspaceSessionDependencies } from "../../../src/app/http/middleware/requireWorkspaceSession.js";
import { createConversationOwnershipRoutes } from "../../../src/app/http/routes/conversationOwnershipRoutes.js";
import { createHeldReplyRoutes } from "../../../src/app/http/routes/heldReplyRoutes.js";
import { createHistoryRoutes } from "../../../src/app/http/routes/historyRoutes.js";
import type { AppDependencies } from "../../../src/app/server/types.js";
import { AnswerCoverageRepository } from "../../../src/db/repositories/answerCoverageRepository.js";
import { AuditEventRepository } from "../../../src/db/repositories/auditEventRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../../src/db/repositories/heldReplyRepository.js";
import { HistoryItemsRepository } from "../../../src/db/repositories/historyItemsRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { UserRepository } from "../../../src/db/repositories/userRepository.js";
import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import { AssistantHistoryService, ChatHistoryService } from "../../../src/modules/chat/composition.js";
import { ReviewTurnAuditReader } from "../../../src/modules/chat/contracts/index.js";
import type { PublicConversationEvent } from "../../../src/modules/chat/services/publicConversationEventBus.js";
import { CustomerReplyDeliveryDispatcher, DeliveryFailureDecisions } from "../../../src/modules/customerReplyDelivery/public.js";
import { EmailSendIntentRepository, NoopEmailChannelDrainDispatcher } from "../../../src/modules/emailChannel/public.js";
import { ConversationOwnershipService, HeldReplyService, OperatorReplyService } from "../../../src/modules/handoff/public.js";
import type { EmailMessage } from "../../../src/modules/mail/public.js";
import { unauthorized } from "../../../src/shared/domain/errors.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import type { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import {
  INBOUND_DOMAIN,
  WEBHOOK_SECRET,
  conversationsOfMailbox,
  postReceived,
  readFixture,
  relayAddressOf,
  seedSupportMailbox,
  type createWorkerNode,
} from "./emailChannelHarness.js";

// The sending side of the email channel's Postgres suites: the API process a teammate replies and
// resolves delivery failures through, the provider's own record of what it accepted, and reads of
// send intents, outbox actions and delivery failures. Workers, which send, are the channel
// harness's `createWorkerNode`.

const SESSION_COOKIE = "radioso_test_session";

/** A signed-in teammate of one workspace. */
interface Teammate {
  accountId: string;
  workspaceId: string;
  userId: string;
}

export const seedTeammate = async (
  database: Database,
  workspace: { accountId: string; workspaceId: string },
): Promise<Teammate> => {
  const userId = randomUUID();
  await database.execute("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [
    userId,
    `teammate-${userId}@example.test`,
  ]);
  return { accountId: workspace.accountId, workspaceId: workspace.workspaceId, userId };
};

class RecordingAudit {
  readonly events: AuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

/**
 * Sign-in reduced to a session cookie naming the teammate, with every workspace permission. The
 * route's own middleware still reads the cookie and the workspace header and checks the permission.
 */
const sessionDependencies = (sessions: ReadonlyMap<string, Teammate>) => {
  const signedIn = (token: string): Teammate => {
    const teammate = sessions.get(token);
    if (!teammate) throw unauthorized();
    return teammate;
  };
  return {
    env: { SESSION_COOKIE_NAME: SESSION_COOKIE },
    authService: {
      authenticateSession: async (token: string) => {
        const teammate = signedIn(token);
        return { accountId: teammate.accountId, userId: teammate.userId, sessionId: token };
      },
    },
    accountAccessService: {
      requireActiveMembership: async () => undefined,
      requirePermission: async () => null,
      hasPermission: async () => true,
    },
    workspaceSessionService: {
      resolve: async (input: { accountId: string; workspaceId?: string }) => {
        const teammate = [...sessions.values()].find((candidate) => candidate.accountId === input.accountId);
        if (!teammate || (input.workspaceId !== undefined && input.workspaceId !== teammate.workspaceId)) throw unauthorized();
        return { accountId: teammate.accountId, workspaceId: teammate.workspaceId };
      },
    },
    // Partial stand-ins for the session services: only the calls above are made.
  } as unknown as WorkspaceSessionDependencies;
};

/**
 * The API process: the conversation reply route over the ownership service and reply unit of work
 * as the server composes them, the held-reply routes over the held-reply service and its unit of
 * work, both delivering to the email channel through the channel composition's reply deliverer,
 * the delivery-failure decisions over the composition's resolver, and the history API over the
 * conversation history as the chat composition builds it. The action drain pushes it would send
 * after a commit are counted, not sent; a worker dispatches the outbox. The public conversation
 * events and the dashboard invalidations it publishes are kept, so a test can see what went out.
 */
const apiNodeDrains = (): never => {
  throw new Error("The API node never drains the email channel");
};

export const createApiNode = (
  database: Database,
  options: {
    spoolDir: string;
    /** The held-reply channel registrations; the channel composition's, as the server registers it, unless a test wraps it. */
    heldReplyChannels?: readonly HeldReplyChannelRegistration[];
  },
) => {
  const db = database.kysely;
  const activity = new ConversationActivityRepository(db);
  const audit = new RecordingAudit();
  const actionDrain = { pushes: 0, requestDrain: async () => { actionDrain.pushes += 1; } };
  const logger = createLogger("silent");
  const invalidations: { workspaceId: string; kinds: readonly WorkspaceInvalidationKind[] }[] = [];
  const publisher = {
    enqueue: (workspaceId: string, kinds: readonly WorkspaceInvalidationKind[]) => {
      invalidations.push({ workspaceId, kinds });
      return { accepted: true as const, coalesced: false };
    },
  };
  const channel = createEmailChannelComposition({
    config: parseEmailChannelConfig({
      EMAIL_CHANNEL_PROVIDER: "local",
      EMAIL_CHANNEL_INBOUND_DOMAIN: INBOUND_DOMAIN,
      EMAIL_CHANNEL_WEBHOOK_SECRET: WEBHOOK_SECRET,
      EMAIL_CHANNEL_WORKERS_ENABLED: true,
    }),
    options: { localSpoolDir: options.spoolDir },
    db,
    drains: new NoopEmailChannelDrainDispatcher(),
    activity,
    // The API node never drains: it neither records inbound mail nor reviews it.
    chat: { ingest: apiNodeDrains, respond: apiNodeDrains },
    heldReplies: {
      hold: apiNodeDrains,
      queueAuto: apiNodeDrains,
      findByReviewRef: apiNodeDrains,
      materializeAuto: apiNodeDrains,
      returnAbandonedAuto: apiNodeDrains,
    },
    // A policy change hands the conversations whose draft it superseded to a person; bound once the
    // ownership rules below are built, as the server binds it.
    ownership: { requestHumanOwnership: (scope, input) => ownership.requestHumanOwnership(scope, input) },
    publisher,
    reviewInference: { create: apiNodeDrains },
    agents: { findByIdAndWorkspaceId: async (agentId) => ({ id: agentId }) },
    audit,
    actionDrain,
    metrics: null,
    logger,
  });
  if (!channel) throw new Error("the local provider composes the email channel");

  const events: PublicConversationEvent[] = [];
  const replies = new OperatorReplyService({
    auditService: audit,
    publicConversationEventBus: { publish: (event) => { events.push(event); } },
    customerReplyDelivery: new CustomerReplyDeliveryDispatcher({ email: channel.customerReplyDeliverer }),
    logger,
  });

  const ownership = new ConversationOwnershipService({
    conversations: new ConversationRepository(db),
    ownership: new ConversationOwnershipRepository(db),
    changes: createPostgresOwnershipChangeUnitOfWork({ db, activity, actionDrain, logger }),
    replyWrites: createPostgresOwnershipReplyUnitOfWork({ db, activity, actionDrain, logger }),
    operators: { find: async () => null },
    operatorIdentities: { resolve: async ({ userId }) => ({ userId, teammateLabel: "Dana Scully", replySignature: null }) },
    replies,
    audit,
    logger,
  });

  const heldReplies = new HeldReplyService({
    conversations: new ConversationRepository(db),
    writes: createPostgresHeldReplyUnitOfWork({
      db,
      channels: options.heldReplyChannels ?? [channel.heldReplyChannel],
      activity,
      actionDrain,
      logger,
    }),
    reads: new HeldReplyRepository(db),
    operatorIdentities: { resolve: async ({ userId }) => ({ userId, teammateLabel: "Dana Scully", replySignature: null }) },
    customerReplyDelivery: new CustomerReplyDeliveryDispatcher({ email: channel.customerReplyDeliverer }),
    replies,
    audit,
    publisher,
    logger,
  });

  const messages = new MessageRepository(db);
  const teammateLabels = createTeammateLabelReader({ users: new UserRepository(db) });
  const history = new ChatHistoryService(
    new ConversationRepository(db),
    messages,
    new AuditEventRepository(db),
    new HistoryItemsRepository(db),
    undefined,
    undefined,
    new ConversationOwnershipRepository(db),
    new AnswerCoverageRepository(db),
    undefined,
    teammateLabels,
    createConversationActivityComposition({ store: activity, teammateLabels, messages }).reads,
  );

  const sessions = new Map<string, Teammate>();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/conversations", createConversationOwnershipRoutes({
    ...sessionDependencies(sessions),
    conversationOperatorDirectory: { list: async () => [], find: async () => null },
    conversationOwnershipService: ownership,
  }));
  app.use("/api/v1", createHeldReplyRoutes({
    ...sessionDependencies(sessions),
    heldReplies,
    reviewTurnAudits: new ReviewTurnAuditReader(new AuditEventRepository(db)),
  }));
  app.use("/api/v1/history", createHistoryRoutes({
    ...sessionDependencies(sessions),
    assistantHistoryService: new AssistantHistoryService(history),
    // Document-search history is not read through this node.
    documentSearchHistoryService: {} as AppDependencies["documentSearchHistoryService"],
  }));
  app.use(createErrorHandler());

  const signIn = (teammate: Teammate): string => {
    const token = randomUUID();
    sessions.set(token, teammate);
    return `${SESSION_COOKIE}=${token}`;
  };

  return {
    channel,
    audit,
    actionDrain,
    events,
    invalidations,
    heldReplies,
    history,
    decisions: new DeliveryFailureDecisions({
      failures: createPostgresDeliveryFailures({ db, activity }),
      resolver: channel.deliveryFailureResolver,
      audit,
      logger,
    }),
    /** `POST /api/v1/conversations/{id}/reply` as the signed-in teammate. */
    reply: (teammate: Teammate, conversationId: string, body: { message: string; expectedVersion: number }) =>
      request(app)
        .post(`/api/v1/conversations/${conversationId}/reply`)
        .set("Cookie", signIn(teammate))
        .set("x-workspace-id", teammate.workspaceId)
        .send(body),
    /** `POST /api/v1/conversations/{id}/takeover` as the signed-in teammate. */
    takeOver: (teammate: Teammate, conversationId: string) =>
      request(app)
        .post(`/api/v1/conversations/${conversationId}/takeover`)
        .set("Cookie", signIn(teammate))
        .set("x-workspace-id", teammate.workspaceId)
        .send({}),
    /** `POST /api/v1/conversations/{id}/held-replies/{heldReplyId}/release` as the signed-in teammate; an edit with `editedText`. */
    releaseHeldReply: (teammate: Teammate, target: { conversationId: string; heldReplyId: string }, body: { editedText?: string } = {}) =>
      request(app)
        .post(`/api/v1/conversations/${target.conversationId}/held-replies/${target.heldReplyId}/release`)
        .set("Cookie", signIn(teammate))
        .set("x-workspace-id", teammate.workspaceId)
        .send(body),
    /** `GET /api/v1/history{path}` as the signed-in teammate, such as `/chat/{id}`. */
    readHistory: (teammate: Teammate, path: string) =>
      request(app)
        .get(`/api/v1/history${path}`)
        .set("Cookie", signIn(teammate))
        .set("x-workspace-id", teammate.workspaceId),
    /** `POST /api/v1/conversations/{id}/held-replies/{heldReplyId}/discard` as the signed-in teammate. */
    discardHeldReply: (teammate: Teammate, target: { conversationId: string; heldReplyId: string }) =>
      request(app)
        .post(`/api/v1/conversations/${target.conversationId}/held-replies/${target.heldReplyId}/discard`)
        .set("Cookie", signIn(teammate))
        .set("x-workspace-id", teammate.workspaceId)
        .send(),
  };
};

type ApiNode = ReturnType<typeof createApiNode>;
type WorkerNode = ReturnType<typeof createWorkerNode>;

// ── Scenario ─────────────────────────────────────────────────────────

/**
 * Alice's first contact, received through `intake`'s webhook and drained by it: an email
 * conversation on a fresh mailbox, and a teammate of its workspace.
 */
export const openEmailConversation = async (
  database: Database,
  intake: { node: WorkerNode; spool: { put(raw: Buffer): Promise<string> } },
  options: Parameters<typeof seedSupportMailbox>[1] = {},
) => {
  const seeded = await seedSupportMailbox(database, options);
  const teammate = await seedTeammate(database, seeded);
  const raw = await readFixture("mime/first-contact.eml", { relayToken: seeded.mailbox.relayToken, domain: seeded.domain.domain });
  const emailId = await intake.spool.put(raw);
  const status = await postReceived(await intake.node.webhook(), { emailId, receivedFor: [relayAddressOf(seeded.mailbox)] });
  const drained = await intake.node.worker.drain({ maxJobs: 5, stage: "inbound" });
  const [conversationId, ...others] = await conversationsOfMailbox(database, seeded.mailbox);
  if (status !== 200 || drained.processed !== 1 || !conversationId || others.length > 0) {
    throw new Error("first contact did not open one conversation");
  }
  return { ...seeded, teammate, conversationId };
};

/** The teammate's reply through the inbox, at the ownership version they see; the message it wrote. */
export const replyFromInbox = async (
  database: Database,
  api: ApiNode,
  conversation: { teammate: Teammate; conversationId: string },
  message = "Hi Alice, you can update it under Settings > Billing.",
): Promise<string> => {
  const response = await api.reply(conversation.teammate, conversation.conversationId, {
    message,
    expectedVersion: await ownershipVersionOf(database, conversation.conversationId),
  });
  if (response.status !== 201) throw new Error(`the reply was refused with ${response.status}`);
  return (response.body as { message: { id: string } }).message.id;
};

// ── Provider ─────────────────────────────────────────────────────────

/** One message the provider accepted: one email the customer receives. */
interface ProviderAccept {
  providerMessageId: string;
  idempotencyKey: string | null;
  message: EmailMessage;
}

/**
 * Every message the local provider accepted, read from its spool. It keeps one entry per
 * idempotency key, so a re-POST under a used key adds none: the count is what customers received.
 */
const providerAccepts = async (spoolDir: string): Promise<ProviderAccept[]> => {
  const directory = join(spoolDir, "outbound");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const sent = JSON.parse(await readFile(join(directory, name), "utf8")) as { providerMessageId: string; message: EmailMessage };
    return { providerMessageId: sent.providerMessageId, idempotencyKey: sent.message.idempotencyKey ?? null, message: sent.message };
  }));
};

/** The accepted messages sent under `idempotencyKey`. */
export const providerAcceptsUnder = async (spoolDir: string, idempotencyKey: string): Promise<ProviderAccept[]> =>
  (await providerAccepts(spoolDir)).filter((accept) => accept.idempotencyKey === idempotencyKey);

// ── Reads ────────────────────────────────────────────────────────────

/** A message's send intents, its send first and then each audited resend. */
export const sendIntentsOf = (database: Database, messageId: string) =>
  new EmailSendIntentRepository(database.kysely).listByMessageId(messageId);

export const sendIntentOf = async (database: Database, messageId: string) => {
  const [intent, ...others] = await sendIntentsOf(database, messageId);
  if (!intent || others.length > 0) throw new Error(`expected one send intent for message ${messageId}`);
  return intent;
};

export const outboxActionsOf = (database: Database, conversationId: string) =>
  database.query<{ id: string; type: string; status: string; attempts: number; idempotency_key: string | null; payload: Record<string, unknown> }>(
    `SELECT id, type, status, attempts, idempotency_key, payload FROM routine_action_requests
      WHERE conversation_id = $1 ORDER BY created_at, id`,
    [conversationId],
  );

export const deliveryFailuresOf = (database: Database, conversationId: string) =>
  database.query<{ id: string; message_id: string | null; failure_kind: string; detail_code: string | null; clear_reason: string | null }>(
    `SELECT id, message_id, failure_kind, detail_code, clear_reason FROM conversation_delivery_failures
      WHERE conversation_id = $1 ORDER BY opened_at, id`,
    [conversationId],
  );

export const messagesOf = (database: Database, conversationId: string) =>
  database.query<{ id: string; role: string; source: string | null; content: string }>(
    "SELECT id, role, source, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
    [conversationId],
  );

export const ownershipVersionOf = async (database: Database, conversationId: string): Promise<number> =>
  (await database.queryOne<{ version: number }>("SELECT version FROM conversation_ownership WHERE conversation_id = $1", [conversationId]))
    .version;

/** Lets a dead worker's outbox claims on the conversation run out, as time passing would. */
export const expireOutboxClaims = async (database: Database, conversationId: string): Promise<void> => {
  await database.execute(
    "UPDATE routine_action_requests SET updated_at = now() - interval '1 hour' WHERE conversation_id = $1 AND status = 'in_progress'",
    [conversationId],
  );
};

/** Brings a send's scheduled re-POST or lookup due now, as time passing would. */
export const makeReconcileDue = async (database: Database, sendIntentId: string): Promise<void> => {
  await database.execute("UPDATE email_send_intents SET next_reconcile_at = now() - interval '1 second' WHERE id = $1", [sendIntentId]);
};

/** A counter's value summed over the series whose labels include `labels`. */
export const counterValue = (metrics: MetricsRegistry, name: string, labels: Record<string, string> = {}): number => {
  // The registry exposes every metric under the `radioso_` namespace.
  const exposed = `radioso_${name}`;
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  return metrics
    .renderPrometheus()
    .split("\n")
    .filter((line) => line.startsWith(`${exposed}{`) || line.startsWith(`${exposed} `))
    .filter((line) => wanted.every((label) => line.includes(label)))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
};
