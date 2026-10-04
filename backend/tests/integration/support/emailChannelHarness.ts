import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectorChatPort, ConnectorContext, ConnectorPlugin } from "@radioso/connector-api";
import express, { type Router } from "express";
import pg from "pg";
import request from "supertest";

import { createPostgresConversationIngestUnitOfWork } from "../../../src/app/composition/conversationIngest.js";
import { createPostgresOwnershipChangeUnitOfWork } from "../../../src/app/composition/conversationOwnershipChanges.js";
import { createPostgresOwnershipReplyUnitOfWork } from "../../../src/app/composition/conversationOwnershipReplies.js";
import {
  createPostgresDeliveryFailures,
  createPostgresEmailSendUnitOfWork,
  createPostgresThreadProtocolUnitOfWork,
} from "../../../src/app/composition/emailChannel.js";
import { createPostgresHeldReplyUnitOfWork, emailHeldReplyChannelRegistration } from "../../../src/app/composition/heldReplyUnitOfWork.js";
import { createPostgresMailboxPolicyChangeUnitOfWork } from "../../../src/app/composition/mailboxPolicyChange.js";
import { ActionRequestRepository } from "../../../src/db/repositories/actionRequestRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../../src/db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { ActionDispatcher, ActionHandlerRegistry, ConversationIngestService } from "../../../src/modules/chat/composition.js";
import { createEmailChannelConnector } from "../../../src/modules/connectors/plugins/index.js";
import {
  EMAIL_SEND_ACTION_TYPE,
  EmailChannelSweep,
  EmailDomainRepository,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailSendActionHandler,
  EmailSendIntentRepository,
  EmailThreadRepository,
  MailboxService,
  ProviderDeliveryEvents,
  ProviderSendAttempt,
  SendIntentWriter,
  SendReconciler,
  generateOpaqueToken,
  type EmailChannelDrainDispatcherPort,
  type EngagementMode,
} from "../../../src/modules/emailChannel/public.js";
import { ConversationOwnershipService, HeldReplyService } from "../../../src/modules/handoff/public.js";
import { LocalEmailDriver } from "../../../src/modules/mail/adapters/localEmailDriver.js";
import { LocalInboundEmailReceiver } from "../../../src/modules/mail/adapters/localInboundReceiver.js";
import {
  EmailSendError,
  rfcMessageId,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
  type RfcMessageId,
  type SentEmailStatus,
} from "../../../src/modules/mail/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { runAllTestMigrations } from "../../support/databaseMigrations.js";

// Shared by the email channel's Postgres suites (thread protocol, inbound end to end, crash
// recovery): a disposable database per file, seeded workspaces and mailboxes, the committed `.eml`
// corpus readdressed per mailbox, a spool the local receiver reads, the signed webhook, and the
// inbound processor assembled over real repositories with test seams around its dependencies.

export const INBOUND_DOMAIN = "in.relay.test";
export const WEBHOOK_SECRET = "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=";

const FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/", import.meta.url));
/** The relay token, customer domain and thread token the committed fixtures are written with. */
const FIXTURE_RELAY_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";
const FIXTURE_DOMAIN = "customer.test";
const FIXTURE_THREAD_TOKEN = "thrA7k2m9qzx4p";

/** A well-formed relay or thread token. */
export const opaqueToken = (): string => generateOpaqueToken((size) => randomBytes(size));

// ── Database ─────────────────────────────────────────────────────────

/** A database created for one suite from `template0`, migrated, and dropped by `close`. */
export const createEmailChannelDatabase = async (
  integrationDatabaseUrl: string,
  label: string,
): Promise<{ database: Database; url: string; close: () => Promise<void> }> => {
  const name = `email_${label}_${randomUUID().replaceAll("-", "")}_test`;
  const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  const url = new URL(integrationDatabaseUrl);
  url.pathname = `/${name}`;
  url.searchParams.delete("options");
  const database = new Database(url.toString());
  await runAllTestMigrations(database);
  return {
    database,
    url: url.toString(),
    close: async () => {
      await database.close().catch(() => undefined);
      const dropper = new pg.Pool({ connectionString: integrationDatabaseUrl });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end().catch(() => undefined);
      }
    },
  };
};

// ── Seeds ────────────────────────────────────────────────────────────

export type SeededMailbox = NonNullable<Awaited<ReturnType<EmailMailboxRepository["createWithPolicy"]>>>;

export const seedWorkspace = async (database: Database): Promise<{ accountId: string; workspaceId: string; agentId: string }> => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
    accountId,
    `email-channel-${accountId}@example.test`,
  ]);
  await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
    workspaceId,
    accountId,
    `rk-${workspaceId}`,
  ]);
  await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')", [agentId, workspaceId]);
  return { accountId, workspaceId, agentId };
};

/** A unique stand-in for the fixtures' `customer.test`. */
export const uniqueCustomerDomain = (): string => `c${randomUUID().slice(0, 8)}.example.test`;

export const seedDomain = async (
  database: Database,
  workspaceId: string,
  domain: string,
  options: { receivingVerified?: boolean } = {},
) => {
  const record = await new EmailDomainRepository(database.kysely).insertActive({
    workspaceId,
    domain,
    provider: "local",
    providerDomainId: `local:${domain}`,
    providerRegion: null,
    dnsRecords: [],
    sendingStatus: "verified",
    receivingStatus: options.receivingVerified ? "verified" : "not_requested",
    nextCheckAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdByUserId: null,
  });
  if (!record) throw new Error("domain fixture conflicted");
  return record;
};

export const seedMailbox = async (
  database: Database,
  input: {
    workspaceId: string;
    domain: { id: string; domain: string };
    local?: string;
    agentId?: string | null;
    engagementMode?: EngagementMode;
    enabled?: boolean;
  },
): Promise<SeededMailbox> => {
  const record = await new EmailMailboxRepository(database.kysely).createWithPolicy({
    workspaceId: input.workspaceId,
    domainId: input.domain.id,
    agentId: input.agentId ?? null,
    address: `${input.local ?? "support"}@${input.domain.domain}`,
    displayName: "Support",
    relayToken: opaqueToken(),
    engagementMode: input.engagementMode ?? "operator_only",
    enabled: input.enabled ?? true,
    threadSendBudget: 3,
    hourlyGenerationBudget: 30,
    threadContextMessages: 10,
    spamOptIn: false,
    silenceThresholdHours: 72,
    createdByUserId: null,
  });
  if (!record) throw new Error("mailbox fixture conflicted");
  return record;
};

/** A workspace, its own customer domain, and one mailbox `support@` on it. */
export const seedSupportMailbox = async (
  database: Database,
  options: { engagementMode?: EngagementMode; enabled?: boolean; withAgent?: boolean } = {},
) => {
  const { accountId, workspaceId, agentId } = await seedWorkspace(database);
  const domain = await seedDomain(database, workspaceId, uniqueCustomerDomain());
  const mailbox = await seedMailbox(database, {
    workspaceId,
    domain,
    agentId: options.withAgent ? agentId : null,
    engagementMode: options.engagementMode,
    enabled: options.enabled,
  });
  return { accountId, workspaceId, agentId, domain, mailbox };
};

/** Appends a policy version the way the settings path does, effective now (research B16). */
export const changeMailboxPolicy = async (
  database: Database,
  mailbox: SeededMailbox,
  policy: { engagementMode: EngagementMode; enabled: boolean; agentId: string | null },
): Promise<void> => {
  const changed = await createPostgresMailboxPolicyChangeUnitOfWork({ db: database.kysely }).run(async (scope) => {
    const locked = await scope.mailboxes.lockForPolicyChange(mailbox.workspaceId, mailbox.id);
    if (!locked) throw new Error("mailbox not found");
    return scope.mailboxes.appendPolicyVersion({
      mailboxId: mailbox.id,
      expectedVersion: locked.policyVersion,
      ...policy,
      changedByUserId: null,
    });
  });
  if (!changed) throw new Error("policy change conflicted");
};

/** Records `rfcMessageId` as a message the mailbox sent on `conversationId`. */
export const seedOutboundMessageId = async (
  database: Database,
  mailbox: SeededMailbox,
  conversationId: string,
  rfcMessageId: string,
): Promise<void> => {
  await new EmailThreadRepository(database.kysely).insertIndexEntries([{
    workspaceId: mailbox.workspaceId,
    mailboxId: mailbox.id,
    conversationId,
    messageId: null,
    direction: "outbound",
    origin: "radioso_generated",
    rfcMessageId,
    subject: null,
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: null,
  }]);
};

// ── Mail ─────────────────────────────────────────────────────────────

export const relayAddressOf = (mailbox: SeededMailbox): string => `${mailbox.relayToken}@${INBOUND_DOMAIN}`;

/**
 * A committed fixture, readdressed: its relay token becomes the one given, `customer.test` the
 * domain given, and its plus tag the thread token given. Bytes are kept as written otherwise.
 */
export const readFixture = async (
  name: string,
  addressing: { relayToken: string; domain: string; threadToken?: string },
): Promise<Buffer> => {
  const text = (await readFile(join(FIXTURES, name))).toString("latin1");
  const readdressed = text
    .replaceAll(FIXTURE_RELAY_TOKEN, addressing.relayToken)
    .replaceAll(FIXTURE_DOMAIN, addressing.domain)
    .replaceAll(FIXTURE_THREAD_TOKEN, addressing.threadToken ?? FIXTURE_THREAD_TOKEN);
  return Buffer.from(readdressed, "latin1");
};

/** The local receiver's spool: each message is `${emailId}.eml`. */
export const createSpool = async (): Promise<{ dir: string; put: (raw: Buffer) => Promise<string>; remove: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "email-spool-"));
  return {
    dir,
    put: async (raw) => {
      const emailId = `local-${randomUUID()}`;
      await writeFile(join(dir, `${emailId}.eml`), raw);
      return emailId;
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};

/**
 * The plugin's webhook, mounted the way the connector host mounts it: at the connector's path,
 * with the raw body captured for the signature. Only the HTTP host and logger are used.
 */
export const mountWebhook = async (plugin: ConnectorPlugin): Promise<express.Express> => {
  const app = express();
  app.use(express.raw({ type: "*/*" }));
  app.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) (req as typeof req & { rawBody?: Buffer }).rawBody = req.body;
    next();
  });
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const http = { mount: (path: string, router: Router) => app.use(`/api/connectors/email${path === "/" ? "" : path}`, router) };
  await plugin.initialize({ logger, http } as unknown as ConnectorContext);
  return app;
};

/** Posts a webhook event of `type`, shaped and signed like Resend's; returns the HTTP status. */
const postSignedEvent = async (
  app: express.Express,
  input: { type: string; data: Record<string, unknown>; svixId?: string },
): Promise<number> => {
  const body = Buffer.from(JSON.stringify({ type: input.type, created_at: new Date().toISOString(), data: input.data }));
  const svixId = input.svixId ?? `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${svixId}.${timestamp}.`).update(body).digest("base64");
  const response = await request(app)
    .post("/api/connectors/email/webhook")
    .set({ "content-type": "application/json", "svix-id": svixId, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` })
    .send(body.toString("utf8"));
  return response.status;
};

/** Posts a signed `email.received` event, shaped like Resend's, for a spooled message. */
export const postReceived = async (
  app: express.Express,
  input: { emailId: string; receivedFor: readonly string[]; svixId?: string },
): Promise<number> =>
  postSignedEvent(app, {
    type: "email.received",
    data: { email_id: input.emailId, created_at: new Date().toISOString(), to: [], cc: [], received_for: input.receivedFor },
    svixId: input.svixId,
  });

/**
 * Posts a signed delivery event about sent mail, such as `email.delivered` or `email.bounced`,
 * naming the send by the provider's id for it. `bounce` is the provider's bounce object, prose
 * included, as Resend sends it.
 */
export const postDeliveryEvent = async (
  app: express.Express,
  input: { type: `email.${string}`; providerMessageId: string; bounce?: { type: string; subType: string; message: string } },
): Promise<number> =>
  postSignedEvent(app, {
    type: input.type,
    data: { email_id: input.providerMessageId, created_at: new Date().toISOString(), ...(input.bounce ? { bounce: input.bounce } : {}) },
  });

// ── Host and processor ───────────────────────────────────────────────

const unused = (): never => {
  throw new Error("Not used by conversation ingest");
};

/** The host's ownership rules over Postgres, for ingest's and a review's hand-off to a person. */
const createHostOwnership = (database: Database): ConversationOwnershipService => {
  const db = database.kysely;
  const activity = new ConversationActivityRepository(db);
  const actionDrain = { requestDrain: async () => undefined };
  const logger = { warn: () => undefined };
  return new ConversationOwnershipService({
    conversations: new ConversationRepository(db),
    ownership: new ConversationOwnershipRepository(db),
    changes: createPostgresOwnershipChangeUnitOfWork({ db, activity, actionDrain, logger }),
    replyWrites: createPostgresOwnershipReplyUnitOfWork({ db, activity, actionDrain, logger }),
    operators: { find: unused },
    operatorIdentities: { resolve: unused },
    replies: { prepare: unused, write: unused, announce: unused, audit: unused },
    audit: { record: unused },
  });
};

/** The host's conversation ingest over Postgres, as `app/server/dependencies.ts` composes it. */
export const createHostIngest = (database: Database): ConversationIngestService =>
  new ConversationIngestService({
    unitOfWork: createPostgresConversationIngestUnitOfWork({ db: database.kysely, activity: new ConversationActivityRepository(database.kysely) }),
    ownership: createHostOwnership(database),
  });

/** A review turn for suites that run none: draining stage 2 there is a test bug. */
const noReviewTurn: ConnectorChatPort["respond"] = async () => {
  throw new Error("This suite runs no review turn");
};

/**
 * Stage 2's host ports over Postgres, as the channel composition binds them: the held-reply
 * producer (the held-reply service and its unit of work), the conversation reads, and the hand-off
 * to a person in its own transaction.
 */
const createReviewPorts = (database: Database): EmailChannelConnectorDependencies["review"] => {
  const db = database.kysely;
  const activity = new ConversationActivityRepository(db);
  const records = new HeldReplyRepository(db);
  const ownershipRules = createHostOwnership(database);
  const heldReplies = new HeldReplyService({
    conversations: new ConversationRepository(db),
    writes: createPostgresHeldReplyUnitOfWork({
      db,
      channels: [emailHeldReplyChannelRegistration],
      activity,
      actionDrain: { requestDrain: async () => undefined },
      logger: { warn: () => undefined },
    }),
    reads: records,
    operatorIdentities: { resolve: unused },
    customerReplyDelivery: { route: unused },
    replies: { write: unused, announce: unused },
    audit: { record: async () => undefined },
  });
  return {
    conversations: {
      latestCustomerMessageId: (conversationId) => records.latestCustomerMessageId(conversationId),
      ownershipVersionOf: async (conversationId) => (await new ConversationOwnershipRepository(db).load(conversationId))?.version ?? 0,
    },
    heldReplies: {
      hold: (input) => heldReplies.hold(input),
      findByReviewRef: (conversationId, reviewRef) => heldReplies.findByReviewRef(conversationId, reviewRef),
      supersedePendingForConversation: (conversationId, reason) => records.supersedePendingForConversation(conversationId, reason),
    },
    handoffs: {
      requestHumanOwnership: async (input) => {
        await db.transaction().execute((trx) => ownershipRules.requestHumanOwnership({
          ownership: new ConversationOwnershipRepository(trx),
          activity: { record: (event) => activity.record(trx, event) },
        }, input));
      },
    },
    maxAttempts: 4,
  };
};

type EmailChannelConnectorDependencies = Parameters<typeof createEmailChannelConnector>[0];

/** Lines the processor and worker log, by message; fields are kept for assertions. */
class RecordingLogger {
  readonly lines: { level: "warn" | "error"; message: string; fields: Record<string, unknown> }[] = [];

  warn(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: "warn", message, fields });
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: "error", message, fields });
  }

  messages(): string[] {
    return this.lines.map((line) => line.message);
  }
}

/** The drains a worker asks for, kept so a test can see a reconcile scheduled. */
class RecordingDrains implements EmailChannelDrainDispatcherPort {
  readonly requests: Parameters<EmailChannelDrainDispatcherPort["requestDrain"]>[0][] = [];

  async requestDrain(request: Parameters<EmailChannelDrainDispatcherPort["requestDrain"]>[0]): Promise<void> {
    this.requests.push(request);
  }
}

/**
 * The processor's dependencies over real repositories, the local receiver and the host's
 * Postgres ingest, as the channel composition assembles them. Domain refresh is out of these
 * suites' scope, so the sweep's domain side is inert.
 */
const createConnectorDependencies = (
  database: Database,
  options: {
    spoolDir: string;
    supportedModes?: readonly EngagementMode[];
    /** The host's review turn; suites that run none leave it out. */
    respond?: ConnectorChatPort["respond"];
    logger: RecordingLogger;
    metrics: MetricsRegistry;
    drains: EmailChannelDrainDispatcherPort;
    sends: Pick<SendPath, "deliveryEvents" | "reconciler">;
  },
): EmailChannelConnectorDependencies => {
  const db = database.kysely;
  const clock = () => new Date();
  const randomBytesOf = (size: number): Uint8Array => randomBytes(size);
  const mailboxes = new EmailMailboxRepository(db);
  const domains = new EmailDomainRepository(db);
  const inbound = new EmailInboundRepository(db);
  const { logger, metrics } = options;
  const supportedModes = options.supportedModes ?? ["operator_only"];
  const hostIngest = createHostIngest(database);
  return {
    receiver: new LocalInboundEmailReceiver({ spoolDir: options.spoolDir, signingSecrets: { current: WEBHOOK_SECRET, previous: null } }),
    inbound,
    mailboxes,
    domains,
    threads: new EmailThreadRepository(db),
    receipts: new MailboxService({
      mailboxes,
      domainRecords: domains,
      sendingDomains: { ensureRegistered: unused },
      policyChanges: createPostgresMailboxPolicyChangeUnitOfWork({ db }),
      agents: { findByIdAndWorkspaceId: async (agentId) => ({ id: agentId }) },
      randomBytes: randomBytesOf,
      clock,
      config: { inboundDomain: INBOUND_DOMAIN, supportedModes },
      audit: { record: async () => undefined },
      logger,
    }),
    deliveryEvents: options.sends.deliveryEvents,
    threadProtocol: createPostgresThreadProtocolUnitOfWork({ db, activity: new ConversationActivityRepository(db) }),
    chat: { ingest: (input) => hostIngest.ingest(input), respond: options.respond ?? noReviewTurn },
    review: createReviewPorts(database),
    drains: options.drains,
    metrics,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: randomBytesOf,
    // Reviews fall due at once, so a suite drains them without waiting out the window.
    config: { inboundDomain: INBOUND_DOMAIN, rawMaxBytes: 2 * 1024 * 1024, supportedModes, coalesceSeconds: 0 },
    workersEnabled: true,
    sweep: new EmailChannelSweep({
      inbound,
      domains: { refreshDue: async () => 0, cleanupRemoved: async () => 0 },
      sends: options.sends.reconciler,
      clock,
      logger,
      config: { eventRetentionDays: 30 },
    }),
  };
};

// ── Send path ────────────────────────────────────────────────────────

/** The Message-ID a provider that rewrites the supplied one delivers a message under. */
export const providerRewrittenMessageId = (providerMessageId: string): RfcMessageId =>
  rfcMessageId(`<${providerMessageId}@mail.provider.test>`);

/**
 * The channel's sending provider as a worker sees it: the local driver, which honours an
 * idempotency key as the provider does (the same key and body return the same id, and the message
 * goes out once), behind two provider behaviours a test may switch on. `loseNextResponse` accepts
 * the next send and loses the answer, an unknown outcome. `rewritesMessageId` withholds the
 * delivered Message-ID from the send response and reports a rewritten one on lookup (research A7).
 */
class ProviderDouble implements EmailDriver {
  /** The idempotency key of every send this worker made, accepted or not. */
  readonly sendKeys: string[] = [];
  private responsesToLose = 0;

  constructor(
    private readonly local: LocalEmailDriver,
    private readonly behaviour: { rewritesMessageId: boolean },
  ) {}

  loseNextResponse(): void {
    this.responsesToLose += 1;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sendKeys.push(message.idempotencyKey ?? "");
    const sent = await this.local.send(message);
    if (this.responsesToLose > 0) {
      this.responsesToLose -= 1;
      throw new EmailSendError("unknown", "timeout");
    }
    return this.behaviour.rewritesMessageId ? { ...sent, deliveredMessageId: null } : sent;
  }

  async lookup(providerMessageId: string): Promise<SentEmailStatus | null> {
    const status = await this.local.lookup(providerMessageId);
    if (!status || !this.behaviour.rewritesMessageId || status.deliveredMessageId === null) return status;
    return { ...status, deliveredMessageId: providerRewrittenMessageId(providerMessageId) };
  }
}

type Guard = <T extends object>(owner: string, target: T) => T;

/**
 * The send path over real repositories, as the channel composition's `createEmailSendServices`
 * assembles it, and the outbox dispatcher a worker delivers `email.send` actions with. Every
 * dependency that reaches Postgres or the provider goes through `guard`, so a killed worker makes
 * no further call on any of them.
 */
const createSendPath = (
  database: Database,
  options: { driver: EmailDriver; guard: Guard; drains: EmailChannelDrainDispatcherPort; metrics: MetricsRegistry; logger: RecordingLogger },
) => {
  const db = database.kysely;
  const { guard, metrics, logger } = options;
  const activity = new ConversationActivityRepository(db);
  const intents = guard("intents", new EmailSendIntentRepository(db));
  const mailboxes = guard("mailboxes", new EmailMailboxRepository(db));
  const domains = guard("domains", new EmailDomainRepository(db));
  const driver = guard("driver", options.driver);
  const unitOfWork = guard("sends", createPostgresEmailSendUnitOfWork({ db, activity }));
  const writer = guard("writer", new SendIntentWriter({ unitOfWork, metrics, logger }));
  const attempt = new ProviderSendAttempt({ driver, writer, unitOfWork, drains: options.drains, metrics, logger, clock: () => new Date() });
  const handler = new EmailSendActionHandler({
    intents,
    unitOfWork,
    messages: guard("messages", new MessageRepository(db)),
    mailboxes,
    domains,
    threads: guard("threads", new EmailThreadRepository(db)),
    attempt,
    writer,
    failures: guard("failures", createPostgresDeliveryFailures({ db, activity })),
    provider: "local",
    metrics,
    logger,
    createId: randomUUID,
  });
  return {
    dispatcher: new ActionDispatcher(
      guard("outbox", new ActionRequestRepository(db)),
      new ActionHandlerRegistry([{ type: EMAIL_SEND_ACTION_TYPE, handler }]),
    ),
    reconciler: new SendReconciler({ intents, mailboxes, domains, driver, attempt, writer, metrics, logger }),
    deliveryEvents: new ProviderDeliveryEvents({ intents, writer, audit: { record: async () => undefined }, metrics, logger }),
  };
};

type SendPath = ReturnType<typeof createSendPath>;

// ── Test seams ───────────────────────────────────────────────────────

/** The stage boundaries of inbound processing and of sending a test may pause at or kill the worker at. */
const SEAMS = [
  "receiver.fetchMessage",
  "inbound.recordFetched",
  "threadProtocol.run",
  "chat.ingest",
  "inbound.recordIngested",
  "threads.completeReview",
  "inbound.settleEvent",
  "outbox.claimPending",
  "driver.send",
  "driver.lookup",
  "writer.apply",
] as const;
export type Seam = (typeof SEAMS)[number];
type SeamHook = (nth: number) => Promise<void> | void;

const isSeam = (name: string): name is Seam => (SEAMS as readonly string[]).includes(name);

/** Thrown at a crash point and by every later call: the worker is dead from then on. */
class WorkerCrashed extends Error {
  constructor() {
    super("worker crashed");
    this.name = "WorkerCrashed";
  }
}

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/**
 * Wraps the processor's dependencies, its existing seams, so a test can pause a worker at a stage
 * boundary or kill it there. A killed worker makes no further call on any dependency, as a dead
 * process would not: its claim stays leased until a sweep recovers it.
 */
class WorkerSeams {
  private crashed = false;
  private readonly calls = new Map<Seam, number>();
  private readonly hooks: { seam: Seam; when: "before" | "after"; hook: SeamHook }[] = [];

  get hasCrashed(): boolean {
    return this.crashed;
  }

  on(seam: Seam, when: "before" | "after", hook: SeamHook): void {
    this.hooks.push({ seam, when, hook });
  }

  /** Kills the worker at the `nth` call of `seam`, before it runs or after it has. */
  crashAt(point: { seam: Seam; when: "before" | "after"; nth?: number }): void {
    this.on(point.seam, point.when, (nth) => {
      if (nth !== (point.nth ?? 1)) return;
      this.crashed = true;
      throw new WorkerCrashed();
    });
  }

  /** Holds the worker at the `nth` call of `seam` until released. */
  pauseAt(seam: Seam, when: "before" | "after", nth = 1): { reached: Promise<void>; release: () => void } {
    const reached = deferred();
    const released = deferred();
    this.on(seam, when, async (call) => {
      if (call !== nth) return;
      reached.resolve();
      await released.promise;
    });
    return { reached: reached.promise, release: released.resolve };
  }

  wrap(deps: EmailChannelConnectorDependencies): EmailChannelConnectorDependencies {
    return {
      ...deps,
      receiver: this.guard("receiver", deps.receiver),
      inbound: this.guard("inbound", deps.inbound),
      mailboxes: this.guard("mailboxes", deps.mailboxes),
      domains: this.guard("domains", deps.domains),
      threads: this.guard("threads", deps.threads),
      receipts: this.guard("receipts", deps.receipts),
      threadProtocol: this.guard("threadProtocol", deps.threadProtocol),
      chat: this.guard("chat", deps.chat),
      drains: this.guard("drains", deps.drains),
    };
  }

  private refuseIfCrashed(): void {
    if (this.crashed) throw new WorkerCrashed();
  }

  private async fire(seam: Seam, when: "before" | "after", nth: number): Promise<void> {
    for (const entry of this.hooks) {
      if (entry.seam === seam && entry.when === when) await entry.hook(nth);
    }
  }

  /** `target` as `owner`: a dead worker's calls on it fail, and its seams fire. */
  guard<T extends object>(owner: string, target: T): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        const seam = `${owner}.${String(property)}`;
        if (!isSeam(seam)) {
          return (...args: unknown[]) => {
            this.refuseIfCrashed();
            return Reflect.apply(method, object, args);
          };
        }
        return async (...args: unknown[]) => {
          this.refuseIfCrashed();
          const nth = (this.calls.get(seam) ?? 0) + 1;
          this.calls.set(seam, nth);
          await this.fire(seam, "before", nth);
          const result: unknown = await Reflect.apply(method, object, args);
          await this.fire(seam, "after", nth);
          return result;
        };
      },
    });
  }
}

/** Resolves once `parties` callers have arrived; fails instead of hanging if they never do. */
export const barrier = (parties: number, timeoutMs = 5_000): { arrive: () => Promise<void> } => {
  let arrived = 0;
  const all = deferred();
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived === parties) all.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`barrier: ${arrived} of ${parties} arrived`)), timeoutMs);
      });
      try {
        await Promise.race([all.promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/**
 * One worker process: its own pool, its own seams, its own provider client and metrics, and over
 * them the webhook, the channel's drain and sweep, and the outbox dispatch that sends `email.send`.
 */
export const createWorkerNode = (
  databaseUrl: string,
  options: {
    spoolDir: string;
    supportedModes?: readonly EngagementMode[];
    rewritesMessageId?: boolean;
    respond?: ConnectorChatPort["respond"];
  },
) => {
  const database = new Database(databaseUrl);
  const seams = new WorkerSeams();
  const logger = new RecordingLogger();
  const metrics = new MetricsRegistry();
  const drains = new RecordingDrains();
  const provider = new ProviderDouble(new LocalEmailDriver({ spoolDir: options.spoolDir }), {
    rewritesMessageId: options.rewritesMessageId ?? false,
  });
  const guard: Guard = (owner, target) => seams.guard(owner, target);
  const sends = createSendPath(database, { driver: provider, guard, drains, metrics, logger });
  const connector = createEmailChannelConnector(
    seams.wrap(createConnectorDependencies(database, { ...options, logger, metrics, drains, sends })),
  );
  // A plugin mounts its router once, at initialization.
  let webhook: Promise<express.Express> | null = null;
  return {
    database,
    seams,
    logger,
    metrics,
    drains,
    provider,
    worker: connector.worker,
    /** One outbox drain, as the action dispatch worker runs it. */
    dispatch: () => sends.dispatcher.dispatchPending(),
    webhook: () => (webhook ??= mountWebhook(connector.plugin)),
    close: () => database.close(),
  };
};

// ── Reads ────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  inbound_event_id: string;
  workspace_id: string | null;
  mailbox_id: string | null;
  route_rule: string | null;
  accepted_policy_version: number | null;
  state: string;
  classification: string | null;
  disposition: string | null;
  disposition_reason: string | null;
  rfc_message_id: string | null;
  thread_match: string | null;
  thread_conflict: boolean;
  planned_conversation_id: string | null;
  planned_message_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
}

/** An event's deliveries, found by the provider object id the webhook carried. */
export const deliveriesOfEmail = async (database: Database, emailId: string): Promise<DeliveryRow[]> =>
  database.query<DeliveryRow>(
    `SELECT d.id, d.inbound_event_id, d.workspace_id, d.mailbox_id, d.route_rule, d.accepted_policy_version, d.state,
            d.classification, d.disposition, d.disposition_reason, d.rfc_message_id, d.thread_match, d.thread_conflict,
            d.planned_conversation_id, d.planned_message_id, d.conversation_id, d.message_id
       FROM email_inbound_deliveries d
       JOIN email_inbound_events e ON e.id = d.inbound_event_id
      WHERE e.provider_object_id = $1
      ORDER BY d.created_at, d.id`,
    [emailId],
  );

export const deliveryOfEmail = async (database: Database, emailId: string): Promise<DeliveryRow> => {
  const [delivery, ...others] = await deliveriesOfEmail(database, emailId);
  if (!delivery || others.length > 0) throw new Error(`expected one delivery for ${emailId}`);
  return delivery;
};

export const eventOfEmail = async (database: Database, emailId: string) =>
  database.queryOne<{ id: string; state: string; attempts: number; last_error_code: string | null }>(
    "SELECT id, state, attempts, last_error_code FROM email_inbound_events WHERE provider_object_id = $1",
    [emailId],
  );

/** Every conversation the mailbox's mail opened, linked or not, so a split thread cannot hide. */
export const conversationsOfMailbox = async (database: Database, mailbox: SeededMailbox): Promise<string[]> =>
  (await database.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE workspace_id = $1 AND source_channel = 'email' AND channel_context->'mailbox'->>'id' = $2
      ORDER BY created_at, id`,
    [mailbox.workspaceId, mailbox.id],
  )).map((row) => row.id);

export const customerMessagesOf = async (database: Database, conversationId: string) =>
  database.query<{ id: string; content: string; role: string; source: string | null }>(
    "SELECT id, content, role, source FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
    [conversationId],
  );

export const activityOf = async (database: Database, conversationId: string) =>
  database.query<{ kind: string; detail: Record<string, unknown> }>(
    "SELECT kind, detail FROM conversation_activity WHERE conversation_id = $1 ORDER BY created_at",
    [conversationId],
  );

export const ownershipOf = async (database: Database, conversationId: string) =>
  database.queryOptional<{ state: string; reason: string | null }>(
    "SELECT state, reason FROM conversation_ownership WHERE conversation_id = $1",
    [conversationId],
  );

export const threadLinksOf = async (database: Database, mailbox: SeededMailbox) =>
  database.query<{ conversation_id: string; participant_address: string; thread_token: string }>(
    "SELECT conversation_id, participant_address, thread_token FROM email_thread_links WHERE mailbox_id = $1",
    [mailbox.id],
  );

export const indexedMessageIdsOf = async (database: Database, conversationId: string): Promise<string[]> =>
  (await database.query<{ rfc_message_id: string }>(
    "SELECT rfc_message_id FROM email_thread_messages WHERE conversation_id = $1 ORDER BY rfc_message_id",
    [conversationId],
  )).map((row) => row.rfc_message_id);

/** Lets a crashed worker's lease run out, as time passing would. */
export const expireLease = async (database: Database, eventId: string): Promise<void> => {
  await database.execute("UPDATE email_inbound_events SET lease_until = now() - interval '1 second' WHERE id = $1", [eventId]);
};
