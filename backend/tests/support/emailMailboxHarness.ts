import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { ConnectorContext, ConnectorPlugin } from "@radioso/connector-api";
import express, { type Router } from "express";
import request from "supertest";

import type { EmailChannelOptions } from "../../src/app/composition/emailChannel/index.js";
import { parseEmailChannelConfig, type Env } from "../../src/app/config/env.js";
import { buildDependencies } from "../../src/app/server/dependencies.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { ChatReviewInput, ChatReviewResult } from "../../src/modules/chat/contracts/index.js";
import { SKILL_TURN_OUTCOME } from "../../src/modules/chat/contracts/index.js";
import { chatReviewResult, reviewTurnFacts } from "../../src/modules/chat/services/reviewDraft.js";
import type { EngagementMode } from "../../src/modules/emailChannel/public.js";
import { isHeldReplyAttentionOpen } from "../../src/modules/handoff/heldReplies/heldReplyState.js";
import { HELD_REPLY_STATES, type HeldReplyState } from "../../src/modules/handoff/public.js";
import { HeldReplyRepository } from "../../src/db/repositories/heldReplyRepository.js";
import { LocalEmailDomainProvisioner } from "../../src/modules/mail/adapters/localDomainProvisioner.js";
import { LOCAL_EMAIL_SPOOL_DIR } from "../../src/modules/mail/adapters/localSpool.js";
import {
  classifyEmailOutcome,
  heldReplySummaryOf,
  ownershipSummaryOf,
  type EmailBusinessOutcome,
  type EmailOutcomeEvidence,
  type SendSummary,
  type SentEmailSummary,
} from "./emailMailboxOutcome.js";

export type {
  EmailAttentionKind,
  EmailBusinessOutcome,
  EmailBusinessOutcomeKind,
  HeldReplySummary,
  OwnershipSummary,
  SentEmailSummary,
} from "./emailMailboxOutcome.js";
export { EmailOutcomeUnsettled } from "./emailMailboxOutcome.js";

/**
 * The email channel's mailbox behaviour harness: the real application composition
 * (`buildDependencies`) with `EMAIL_CHANNEL_PROVIDER=local`, a seeded workspace, operator, agent and
 * knowledge corpus, and a mailbox on a verified sending domain. Mail goes in as the provider would
 * deliver it (a raw message in the local receiver's spool and a signed `email.received` webhook to
 * the channel's plugin), the channel's stages are drained in-process (inbound, the coalesced
 * review, the `email.send` outbox), and each email's business outcome is read back from Postgres
 * and the local driver's outbound spool. The review turn and the review's model checks (the reply
 * triage and the completeness check) are the real ones, the model included, unless a deterministic
 * suite passes `reviewTurn`: then the turn is scripted, every mail needs a reply, and every reply is
 * complete.
 */

const WEBHOOK_PATH = "/api/connectors/email/webhook";
const SETTLED_EVENT_STATES = ["processed", "ignored", "failed"] as const;
const SETTLED_DELIVERY_STATES: ReadonlySet<string> = new Set(["done", "failed"]);
const DRAIN_BATCH = 10;
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000;
const DEFAULT_DOCUMENT_TIMEOUT_MS = 180_000;
const IDLE_POLL_MS = 250;
const MAX_WAIT_STEP_MS = 2_000;

type Deps = AppDependencies;

export interface CorpusDocument {
  title: string;
  content: string;
}

/** A scripted review turn, for suites that must not call a model. */
export type ReviewTurnStub =
  | { kind: "draft"; text: string; grounded: boolean; coverage?: "answered" | "partial" | "unanswered"; handoffReason?: string }
  | { kind: "no_draft"; handoffReason?: string };

export type ReviewTurnScript = (turn: { conversationId: string; customerText: string }) => ReviewTurnStub;

export interface EmailMailboxHarnessOptions {
  /** Parsed environment. The email channel must use the local provider with its workers enabled. */
  env: Env;
  /** The spool and timings for this run, such as a short coalescing window; the channel's own otherwise. */
  emailChannel?: EmailChannelOptions;
  company: {
    name: string;
    /** The sending domain every mailbox is created on; verified at boot. */
    domain: string;
    operatorEmail: string;
    operatorName: string;
  };
  agent: { name: string; instruction: string };
  /** Markdown documents, one per file, the agent answers from; the title is the first `# ` heading. */
  corpusDir?: string;
  /** Replaces the host's review turn; left out, every review runs the real turn and its model. */
  reviewTurn?: ReviewTurnScript;
  documentTimeoutMs?: number;
}

export interface InboundEmail {
  from: string | { address: string; name?: string };
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: readonly string[];
  /** Extra header lines, such as `Auto-Submitted`. */
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly { filename: string; contentType: string; content: string | Buffer }[];
  /** Defaults to a fresh id at the sender's domain. */
  messageId?: string;
}

export interface InboundReceipt {
  /** The provider object id the webhook named; the spool file is `${emailId}.eml`. */
  emailId: string;
  /** The email's own `Message-ID`, angle brackets included. */
  messageId: string;
  from: string;
  subject: string;
}

/** A message the local provider accepted from one of the harness's mailboxes. */
export interface SpooledEmail extends SentEmailSummary {
  providerMessageId: string;
  from: string;
}

export interface SettleReport {
  rounds: number;
  inboundClaimed: number;
  /** Reviews the channel claimed, including those that ended without a turn. */
  reviewsRun: number;
  /** Review turns the host ran. */
  turnsRun: number;
  actionsDispatched: number;
}

interface Operator {
  accountId: string;
  userId: string;
  workspaceId: string;
}

interface LocalSpoolRecord {
  providerMessageId: string;
  message: {
    to: string;
    from: { email: string };
    subject: string;
    text: string;
    threading?: { messageId: string; inReplyTo: string | null; autoSubmitted: string | null } | null;
  };
}

// ── Raw mail ─────────────────────────────────────────────────────────

const CRLF = "\r\n";

const encodeHeaderWord = (value: string): string =>
  /^[\x20-\x7e]*$/u.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const addressOf = (from: InboundEmail["from"]): { address: string; name: string | undefined } =>
  typeof from === "string" ? { address: from, name: undefined } : { address: from.address, name: from.name };

/**
 * A raw RFC 5322 message as a customer's mail client sends it to the mailbox, with the relay
 * address the forwarding rule added on top as `Delivered-To`, as the provider's MTA records it.
 */
export const buildRawEmail = (input: InboundEmail & { to: string; relayAddress: string; messageId: string; date?: Date }): Buffer => {
  const from = addressOf(input.from);
  const fromHeader = from.name ? `${encodeHeaderWord(from.name)} <${from.address}>` : from.address;
  const headers = [
    `Delivered-To: ${input.relayAddress}`,
    `Return-Path: <${from.address}>`,
    `Delivered-To: ${input.to}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references && input.references.length > 0 ? [`References: ${input.references.join(" ")}`] : []),
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", input.text].join(CRLF);
  if (!input.attachments || input.attachments.length === 0) {
    return Buffer.from([...headers, textPart, ""].join(CRLF), "utf8");
  }
  const boundary = `harness-${randomUUID()}`;
  const parts = [
    textPart,
    ...input.attachments.map((attachment) => [
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      (typeof attachment.content === "string" ? Buffer.from(attachment.content, "utf8") : attachment.content)
        .toString("base64")
        .replace(/.{1,76}/gu, (line) => `${line}${CRLF}`)
        .trimEnd(),
    ].join(CRLF)),
  ];
  return Buffer.from([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}${CRLF}${part}`),
    `--${boundary}--`,
    "",
  ].join(CRLF), "utf8");
};

/** The Svix-style signature the provider sends, over this exact body. */
const signedHeaders = (secret: string, svixId: string, body: string): Record<string, string> => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  const signature = createHmac("sha256", key).update(`${svixId}.${timestamp}.${body}`).digest("base64");
  return { "content-type": "application/json", "svix-id": svixId, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
};

/** The channel's plugin mounted as the connector host mounts it, with the raw body captured for the signature. */
const mountWebhook = async (plugin: ConnectorPlugin, logger: Deps["logger"]): Promise<express.Express> => {
  const app = express();
  app.use(express.raw({ type: "*/*" }));
  app.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) (req as typeof req & { rawBody?: Buffer }).rawBody = req.body;
    next();
  });
  const http = { mount: (path: string, router: Router) => app.use(`/api/connectors/email${path === "/" ? "" : path}`, router) };
  // The plugin reads only the HTTP host and the logger at initialization.
  await plugin.initialize({ logger, http } as unknown as ConnectorContext);
  return app;
};

// ── Corpus ───────────────────────────────────────────────────────────

/** Every `.md` file of `dir`, titled by its first `# ` heading, or by its file name without one. */
export const readCorpusDirectory = async (dir: string): Promise<CorpusDocument[]> => {
  const names = (await readdir(dir)).filter((name) => extname(name) === ".md").sort();
  return Promise.all(names.map(async (name) => {
    const content = await readFile(join(dir, name), "utf8");
    const heading = content.split("\n").find((line) => line.startsWith("# "));
    return { title: heading ? heading.slice(2).trim() : basename(name, ".md"), content };
  }));
};

/** The workspace's documents as corpus reconciliation reads and writes them. */
export interface CorpusStore {
  list(): Promise<readonly { documentId: string; externalDocumentId: string | null }[]>;
  /** Ingests the document under its key and returns its id. */
  ingest(document: CorpusDocument & { externalDocumentId: string }): Promise<string>;
  remove(documentId: string): Promise<void>;
}

const CORPUS_KEY_PREFIX = "email-behaviour-corpus:";

/** A corpus document's key is its content's hash: an edited file is a different document. */
const corpusKey = (document: CorpusDocument): string =>
  `${CORPUS_KEY_PREFIX}${createHash("sha256").update(document.title).update("\n").update(document.content).digest("hex")}`;

/**
 * Makes the workspace's documents exactly the corpus, keyed by content hash. A document whose hash
 * is stored is reused; a new or edited one is ingested; every other document is deleted: an earlier
 * version of an edited file, a file since removed, or one an earlier harness stored by title. A
 * reused database therefore never retrieves stale corpus content. Returns the ids in corpus order.
 */
export const reconcileCorpus = async (store: CorpusStore, documents: readonly CorpusDocument[]): Promise<string[]> => {
  const stored = await store.list();
  const byKey = new Map<string, string>();
  for (const row of stored) {
    if (row.externalDocumentId) byKey.set(row.externalDocumentId, row.documentId);
  }
  const ids: string[] = [];
  for (const document of documents) {
    const key = corpusKey(document);
    const documentId = byKey.get(key) ?? await store.ingest({ ...document, externalDocumentId: key });
    byKey.set(key, documentId);
    ids.push(documentId);
  }
  const current = new Set(ids);
  for (const row of stored) {
    if (!current.has(row.documentId)) await store.remove(row.documentId);
  }
  return ids;
};

// ── Harness ──────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Disposition = NonNullable<EmailOutcomeEvidence["delivery"]>["disposition"];
const DISPOSITIONS: readonly string[] = ["drop", "ingest_only", "run_review_turn"] satisfies readonly Disposition[];
const isDisposition = (value: string | null): value is Disposition => value !== null && DISPOSITIONS.includes(value);
const isHeldReplyState = (value: string): value is HeldReplyState => (HELD_REPLY_STATES as readonly string[]).includes(value);

const requireLocalChannel = (env: Env, options: EmailChannelOptions) => {
  const config = parseEmailChannelConfig(env);
  if (config?.provider.kind !== "local") {
    throw new Error("The mailbox harness drives the local provider; set EMAIL_CHANNEL_PROVIDER=local.");
  }
  if (!config.workersEnabled) {
    throw new Error("The mailbox harness drains the channel's stages; set EMAIL_CHANNEL_WORKERS_ENABLED=true.");
  }
  return { spoolDir: options.localSpoolDir ?? LOCAL_EMAIL_SPOOL_DIR, webhookSecret: config.webhookSecret, inboundDomain: config.inboundDomain };
};

/** Replaces the host's review turn with a script, keeping the rest of the turn's contract. */
const installReviewTurn = (deps: Deps, script: ReviewTurnScript): void => {
  const db = deps.connectorDb.kysely;
  deps.chatService.review = async (input: ChatReviewInput): Promise<ChatReviewResult> => {
    const ownership = await deps.conversationOwnershipService.load(input.conversationId);
    const ownershipVersion = ownership?.version ?? 0;
    if (ownership?.state === "human_owned") return { kind: "human_owned", conversationId: input.conversationId, ownershipVersion };
    const message = await db.selectFrom("messages").select("content").where("id", "=", input.existingUserMessageId).executeTakeFirstOrThrow();
    const stub = script({ conversationId: input.conversationId, customerText: message.content });
    const grounded = stub.kind === "draft" && stub.grounded;
    const coverage = stub.kind === "draft" ? stub.coverage ?? (stub.grounded ? "answered" : "unanswered") : "unanswered";
    const facts = reviewTurnFacts({
      answerOutcome: grounded ? "grounded_success" : "no_context_refusal",
      answerCoverage: { availability: "assessed", coverage, originatingTurnId: "stub-turn", originatingRequestId: input.existingUserMessageId },
      skillOutcome: grounded ? SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.outcome : SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome,
      ownershipHandoff: stub.handoffReason ? { reason: stub.handoffReason } : null,
      suppressedEffects: [],
      citationCount: grounded ? 1 : 0,
    });
    return chatReviewResult({
      conversationId: input.conversationId,
      ownershipVersion,
      draft: { text: stub.kind === "draft" ? stub.text : "", presentation: {} },
      facts,
    });
  };
};

/** Scripts the review's model checks alongside a scripted turn: every mail needs a reply, every reply is complete. */
const installReviewChecks = (deps: Deps): void => {
  const checks = deps.emailReviewChecks;
  if (!checks) throw new Error("The email channel's review checks are not composed");
  checks.replyTriage = { assess: async () => "yes" };
  checks.replyCompleteness = { assess: async () => ({ completeness: "complete", unansweredAsks: 0 }) };
};

/** Counts the host's review turns, scripted or real, so a step can tell whether a turn ran. */
const countReviewTurns = (deps: Deps): { count: number } => {
  const turns = { count: 0 };
  const review = deps.chatService.review.bind(deps.chatService);
  deps.chatService.review = async (input: ChatReviewInput): Promise<ChatReviewResult> => {
    turns.count += 1;
    return review(input);
  };
  return turns;
};

export class EmailMailboxHarness {
  private readonly postedEmailIds = new Set<string>();
  private readonly mailboxIds = new Set<string>();

  private constructor(
    readonly deps: Deps,
    readonly operator: Operator,
    readonly agentId: string,
    readonly domain: { id: string; name: string },
    private readonly channel: { spoolDir: string; webhookSecret: string; inboundDomain: string },
    private readonly webhook: express.Express,
    private readonly turns: { count: number },
  ) {}

  /** Boots the composition, seeds the workspace, operator, agent and corpus, and verifies the sending domain. */
  static async boot(options: EmailMailboxHarnessOptions): Promise<EmailMailboxHarness> {
    const channel = requireLocalChannel(options.env, options.emailChannel ?? {});
    const deps = buildDependencies(options.env, { emailChannel: { ...options.emailChannel, localSpoolDir: channel.spoolDir } });
    try {
      if (options.reviewTurn) {
        installReviewTurn(deps, options.reviewTurn);
        installReviewChecks(deps);
      }
      const turns = countReviewTurns(deps);
      await deps.applicationModules.initializeAll();
      const operator = await ensureOperator(deps, options.company);
      const agentId = await ensurePublishedAgent(deps, operator.workspaceId, options.agent);
      if (options.corpusDir) {
        await seedCorpus(deps, operator, await readCorpusDirectory(options.corpusDir), options.documentTimeoutMs ?? DEFAULT_DOCUMENT_TIMEOUT_MS);
      }
      const domain = await verifySendingDomain(deps, operator, channel.spoolDir, options.company.domain);
      const plugin = deps.connectorRegistry.getPlugin("email");
      if (!plugin) throw new Error("The email channel's plugin is not registered; is the email channel configured?");
      const webhook = await mountWebhook(plugin, deps.logger);
      return new EmailMailboxHarness(deps, operator, agentId, domain, channel, webhook, turns);
    } catch (error) {
      await shutdown(deps);
      throw error;
    }
  }

  get workspaceId(): string {
    return this.operator.workspaceId;
  }

  get spoolDir(): string {
    return this.channel.spoolDir;
  }

  /** A mailbox `local@<domain>` in `mode`, answered by the harness's agent. */
  async openMailbox(input: { mode: EngagementMode; local: string; displayName?: string }): Promise<EmailMailbox> {
    const mailboxes = this.requireChannel().mailboxes;
    const view = await mailboxes.create(this.channelActor(), this.workspaceId, {
      address: `${input.local}@${this.domain.name}`,
      displayName: input.displayName ?? "Support",
      agentId: this.agentId,
      engagementMode: input.mode,
      ...(input.mode === "auto" ? { autoOptIn: true } : {}),
    });
    if (view.sending.state !== "ok") throw new Error(`Mailbox ${view.address} cannot send: ${view.sending.state}`);
    this.mailboxIds.add(view.id);
    return new EmailMailbox(this, { id: view.id, address: view.address, relayAddress: view.relayAddress });
  }

  /**
   * Drains the channel until nothing is left to do now: inbound events, reviews (once their
   * coalescing window passes), and the outbox that sends. Fails after `timeoutMs`.
   */
  async settle(options: { timeoutMs?: number } = {}): Promise<SettleReport> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
    const report: SettleReport = { rounds: 0, inboundClaimed: 0, reviewsRun: 0, turnsRun: 0, actionsDispatched: 0 };
    const turnsBefore = this.turns.count;
    const worker = this.deps.emailChannelWorker;
    if (!worker) throw new Error("The email channel worker is not composed");
    for (;;) {
      report.rounds += 1;
      const drained = await worker.drain({ maxJobs: DRAIN_BATCH, stage: "all" });
      const actions = await this.deps.actionDispatchWorker.drain();
      report.inboundClaimed += drained.claimed;
      report.reviewsRun += drained.reviewed;
      report.turnsRun = this.turns.count - turnsBefore;
      report.actionsDispatched += actions?.dispatched ?? 0;
      const worked = drained.claimed + drained.reviewed + drained.reconciled + (actions?.dispatched ?? 0) + (actions?.retried ?? 0) > 0;
      const outstanding = await this.outstanding();
      if (!worked && outstanding.count === 0) return report;
      if (Date.now() > deadline) {
        throw new Error(`settle timed out with work outstanding: ${JSON.stringify(outstanding)}`);
      }
      if (!worked) {
        const untilDue = outstanding.nextDueAt ? outstanding.nextDueAt.getTime() - Date.now() : IDLE_POLL_MS;
        await sleep(Math.min(MAX_WAIT_STEP_MS, Math.max(IDLE_POLL_MS, untilDue + 50)));
      }
    }
  }

  /** Model usage the workspace recorded since `since`, by model and operation. */
  async modelUsage(since: Date): Promise<{ model: string; operation: string; calls: number }[]> {
    const rows = await this.db.selectFrom("usage_events")
      .select(["model", "operation", (eb) => eb.fn.countAll<string>().as("calls")])
      .where("workspace_id", "=", this.workspaceId)
      .where("created_at", ">=", since)
      .groupBy(["model", "operation"])
      .orderBy("model")
      .orderBy("operation")
      .execute();
    return rows.map((row) => ({ model: row.model, operation: row.operation, calls: Number(row.calls) }));
  }

  async close(): Promise<void> {
    await shutdown(this.deps);
  }

  // ── Used by mailboxes ──

  /** @internal Spools the raw message and posts the signed `email.received` webhook the provider would. */
  async deliver(raw: Buffer, input: { relayAddress: string; to: string; from: string; subject: string; messageId: string }): Promise<string> {
    const emailId = `local-${randomUUID()}`;
    await mkdir(this.channel.spoolDir, { recursive: true });
    await writeFile(join(this.channel.spoolDir, `${emailId}.eml`), raw);
    const createdAt = new Date().toISOString();
    const body = JSON.stringify({
      type: "email.received",
      created_at: createdAt,
      data: {
        email_id: emailId,
        created_at: createdAt,
        from: input.from,
        to: [input.to],
        cc: [],
        received_for: [input.relayAddress],
        message_id: input.messageId,
        subject: input.subject,
      },
    });
    const svixId = `msg_${randomUUID().replaceAll("-", "")}`;
    const response = await request(this.webhook).post(WEBHOOK_PATH).set(signedHeaders(this.channel.webhookSecret, svixId, body)).send(body);
    if (response.status !== 200) throw new Error(`The email webhook answered ${response.status}`);
    this.postedEmailIds.add(emailId);
    return emailId;
  }

  /** @internal */
  get db() {
    return this.deps.connectorDb.kysely;
  }

  /** @internal */
  requireChannel(): NonNullable<Deps["emailChannel"]> {
    const channel = this.deps.emailChannel;
    if (!channel) throw new Error("The email channel is not composed");
    return channel;
  }

  /** @internal */
  channelActor(): { userId: string; accountId: string } {
    return { userId: this.operator.userId, accountId: this.operator.accountId };
  }

  /** @internal Every message the local provider accepted, newest last by file time. */
  async readSpool(): Promise<SpooledEmail[]> {
    const dir = join(this.channel.spoolDir, "outbound");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")) as LocalSpoolRecord));
    return records.map(spooledEmailOf);
  }

  /** @internal The message the local provider accepted under `providerMessageId`, if any. */
  async spooledEmail(providerMessageId: string): Promise<SentEmailSummary | null> {
    try {
      return spooledEmailOf(JSON.parse(await readFile(join(this.channel.spoolDir, "outbound", `${providerMessageId}.json`), "utf8")) as LocalSpoolRecord);
    } catch {
      return null;
    }
  }

  /** Work still due or running for the harness's mail, and when the soonest of it falls due. */
  private async outstanding(): Promise<{ count: number; nextDueAt: Date | null; detail: Record<string, number> }> {
    const db = this.db;
    const emailIds = [...this.postedEmailIds];
    const mailboxIds = [...this.mailboxIds];
    const [events, reviews, actions, queued, intents] = await Promise.all([
      emailIds.length === 0
        ? Promise.resolve([])
        : db.selectFrom("email_inbound_events").select(["next_attempt_at"])
          .where("provider_object_id", "in", emailIds)
          .where("state", "not in", SETTLED_EVENT_STATES)
          .execute(),
      mailboxIds.length === 0
        ? Promise.resolve([])
        : db.selectFrom("email_thread_links").select(["review_due_at"])
          .where("mailbox_id", "in", mailboxIds)
          .whereRef("review_revision", ">", "review_completed_revision")
          .execute(),
      db.selectFrom("routine_action_requests").select(["next_attempt_at"])
        .where("workspace_id", "=", this.workspaceId)
        .where("status", "in", ["pending", "in_progress"])
        .execute(),
      db.selectFrom("held_replies").select("id").where("workspace_id", "=", this.workspaceId).where("state", "=", "queued_auto").execute(),
      db.selectFrom("email_send_intents").select("id").where("workspace_id", "=", this.workspaceId).where("state", "=", "queued").execute(),
    ]);
    const dueTimes = [
      ...events.map((row) => row.next_attempt_at),
      ...reviews.map((row) => row.review_due_at),
      ...actions.map((row) => row.next_attempt_at),
    ].filter((at): at is Date => at instanceof Date);
    const detail = { events: events.length, reviews: reviews.length, actions: actions.length, queuedAuto: queued.length, queuedSends: intents.length };
    return {
      count: Object.values(detail).reduce((sum, value) => sum + value, 0),
      nextDueAt: dueTimes.length === 0 ? null : new Date(Math.min(...dueTimes.map((at) => at.getTime()))),
      detail,
    };
  }
}

const spooledEmailOf = (record: LocalSpoolRecord): SpooledEmail => ({
  providerMessageId: record.providerMessageId,
  from: record.message.from.email,
  to: record.message.to,
  subject: record.message.subject,
  text: record.message.text,
  autoSubmitted: record.message.threading?.autoSubmitted ?? null,
  messageId: record.message.threading?.messageId ?? "",
  inReplyTo: record.message.threading?.inReplyTo ?? null,
});

/** One mailbox of the harness: mail in, outcomes out, and the operator's hands on it. */
export class EmailMailbox {
  constructor(
    private readonly harness: EmailMailboxHarness,
    readonly mailbox: { id: string; address: string; relayAddress: string },
  ) {}

  get address(): string {
    return this.mailbox.address;
  }

  /** Delivers a customer's email to the mailbox as the provider's webhook would. */
  async inbound(mail: InboundEmail): Promise<InboundReceipt> {
    const from = addressOf(mail.from).address;
    const messageId = mail.messageId ?? `<${randomUUID()}@${from.split("@")[1] ?? "customer.test"}>`;
    const raw = buildRawEmail({ ...mail, to: this.mailbox.address, relayAddress: this.mailbox.relayAddress, messageId });
    const emailId = await this.harness.deliver(raw, {
      relayAddress: this.mailbox.relayAddress,
      to: this.mailbox.address,
      from,
      subject: mail.subject,
      messageId,
    });
    return { emailId, messageId, from, subject: mail.subject };
  }

  settle(options?: { timeoutMs?: number }): Promise<SettleReport> {
    return this.harness.settle(options);
  }

  /** The conversation an email landed in; null when it was set aside without one. */
  async conversationOf(receipt: InboundReceipt): Promise<string | null> {
    return (await this.deliveryOf(receipt.emailId))?.conversation_id ?? null;
  }

  /**
   * The business outcome of an email, or of the newest email on a conversation. Throws
   * `EmailOutcomeUnsettled` while the pipeline still has work for it; `settle()` first.
   */
  async outcome(target: InboundReceipt | string): Promise<EmailBusinessOutcome> {
    return classifyEmailOutcome(await this.evidence(target));
  }

  /** Every message the local provider accepted from this mailbox. */
  async spool(): Promise<SpooledEmail[]> {
    return (await this.harness.readSpool()).filter((email) => email.from === this.mailbox.address);
  }

  async takeOver(conversationId?: string): Promise<void> {
    const id = conversationId ?? await this.latestConversationId();
    const result = await this.harness.deps.conversationOwnershipService.takeOver(this.harness.operator, { conversationId: id });
    if (!result.ok) throw new Error(`Take-over refused: ${result.refusal}`);
  }

  async operatorReply(text: string, conversationId?: string): Promise<void> {
    const id = conversationId ?? await this.latestConversationId();
    const result = await this.harness.deps.conversationOwnershipService.reply(this.harness.operator, { conversationId: id, message: text });
    if (!result.ok) throw new Error(`Reply refused: ${result.refusal}`);
  }

  /** Releases the conversation's current held reply, as written or with the teammate's edit. */
  async release(input: { conversationId?: string; editedText?: string } = {}): Promise<void> {
    const conversationId = input.conversationId ?? await this.latestConversationId();
    const { heldReply } = await this.harness.deps.heldReplies.current(this.harness.operator, conversationId);
    if (!heldReply) throw new Error(`Conversation ${conversationId} has no held reply to release`);
    const result = await this.harness.deps.heldReplies.release(this.harness.operator, {
      conversationId,
      heldReplyId: heldReply.id,
      editedText: input.editedText ?? null,
    });
    if (!result.ok) throw new Error(`Release refused: ${result.refusal}`);
  }

  async setMode(mode: EngagementMode): Promise<void> {
    await this.harness.requireChannel().mailboxes.update(this.harness.channelActor(), this.harness.workspaceId, this.mailbox.id, {
      engagementMode: mode,
      ...(mode === "auto" ? { autoOptIn: true } : {}),
    });
  }

  private deliveryOf(emailId: string) {
    return this.harness.db.selectFrom("email_inbound_deliveries as d")
      .innerJoin("email_inbound_events as e", "e.id", "d.inbound_event_id")
      .select([
        "d.id",
        "d.state",
        "d.disposition",
        "d.disposition_reason",
        "d.conversation_id",
        "d.message_id",
        "d.created_at",
        "e.state as event_state",
      ])
      .where("e.provider_object_id", "=", emailId)
      .where("d.mailbox_id", "=", this.mailbox.id)
      .executeTakeFirst();
  }

  private async latestConversationId(): Promise<string> {
    const row = await this.harness.db.selectFrom("email_inbound_deliveries")
      .select("conversation_id")
      .where("mailbox_id", "=", this.mailbox.id)
      .where("conversation_id", "is not", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row?.conversation_id) throw new Error(`Mailbox ${this.mailbox.address} has no conversation yet`);
    return row.conversation_id;
  }

  private async emailIdFor(target: InboundReceipt | string): Promise<string | null> {
    if (typeof target !== "string") return target.emailId;
    const row = await this.harness.db.selectFrom("email_inbound_deliveries as d")
      .innerJoin("email_inbound_events as e", "e.id", "d.inbound_event_id")
      .select("e.provider_object_id")
      .where("d.mailbox_id", "=", this.mailbox.id)
      .where("d.conversation_id", "=", target)
      .orderBy("d.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.provider_object_id ?? null;
  }

  private async evidence(target: InboundReceipt | string): Promise<EmailOutcomeEvidence> {
    const emailId = await this.emailIdFor(target);
    const delivery = emailId ? await this.deliveryOf(emailId) : undefined;
    const noConversation = {
      reviewPending: false,
      heldReply: null,
      send: null,
      ownership: ownershipSummaryOf(null),
      attentionOpen: false,
      openDeliveryFailure: false,
      setAside: null,
    };
    if (!delivery || !isDisposition(delivery.disposition)) return { delivery: null, ...noConversation };
    const settled = (SETTLED_EVENT_STATES as readonly string[]).includes(delivery.event_state) && SETTLED_DELIVERY_STATES.has(delivery.state);
    const recorded = {
      disposition: delivery.disposition,
      reason: delivery.disposition_reason ?? "",
      conversationId: delivery.conversation_id,
      settled,
    };
    const conversationId = delivery.conversation_id;
    if (!conversationId) return { delivery: recorded, ...noConversation };

    const db = this.harness.db;
    const [link, heldReply, ownership, heldRows, failures, setAside] = await Promise.all([
      db.selectFrom("email_thread_links").select(["review_revision", "review_completed_revision"]).where("conversation_id", "=", conversationId).executeTakeFirst(),
      this.heldReplyAnswering(conversationId, delivery.message_id),
      this.harness.deps.conversationOwnershipService.load(conversationId),
      db.selectFrom("held_replies").select(["state", "attention_cleared_at"]).where("conversation_id", "=", conversationId).execute(),
      db.selectFrom("conversation_delivery_failures").select("id").where("conversation_id", "=", conversationId).where("cleared_at", "is", null).execute(),
      this.setAsideNote(conversationId, delivery.id),
    ]);
    return {
      delivery: recorded,
      reviewPending: link ? link.review_revision > link.review_completed_revision : false,
      heldReply: heldReply ? heldReplySummaryOf(heldReply) : null,
      send: await this.sendAnswering(conversationId, delivery.created_at, heldReply?.id ?? null),
      ownership: ownershipSummaryOf(ownership),
      attentionOpen: heldRows.some((row) => isHeldReplyState(row.state) && isHeldReplyAttentionOpen({ state: row.state, attentionClearedAt: row.attention_cleared_at })),
      openDeliveryFailure: failures.length > 0,
      setAside,
    };
  }

  /** The code of the thread note the channel left on this delivery when it set the email aside, if any. */
  private async setAsideNote(conversationId: string, deliveryId: string): Promise<string | null> {
    const notes = await this.harness.db.selectFrom("conversation_activity")
      .select("detail")
      .where("conversation_id", "=", conversationId)
      .where("kind", "=", "channel_exception")
      .execute();
    const note = notes.map((row) => row.detail as { code?: unknown; deliveryId?: unknown })
      .find((detail) => detail.deliveryId === deliveryId && typeof detail.code === "string");
    return typeof note?.code === "string" ? note.code : null;
  }

  /** The newest held reply answering this customer message or a later one on the thread. */
  private async heldReplyAnswering(conversationId: string, messageId: string | null) {
    if (!messageId) return null;
    const db = this.harness.db;
    const message = await db.selectFrom("messages").select("created_at").where("id", "=", messageId).executeTakeFirst();
    if (!message) return null;
    const row = await db.selectFrom("held_replies as h")
      .innerJoin("messages as m", "m.id", "h.answers_message_id")
      .select("h.id")
      .where("h.conversation_id", "=", conversationId)
      .where("m.created_at", ">=", message.created_at)
      .orderBy("h.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? new HeldReplyRepository(db).findById(row.id) : null;
  }

  /** The send that answered the email: its held reply's, else the first made on the thread after it arrived. */
  private async sendAnswering(conversationId: string, after: Date, heldReplyId: string | null): Promise<SendSummary | null> {
    const intents = await this.harness.db.selectFrom("email_send_intents")
      .select(["state", "trigger", "author_kind", "halt_reason", "provider_message_id", "held_reply_id"])
      .where("conversation_id", "=", conversationId)
      .where("created_at", ">=", after)
      .orderBy("created_at")
      .execute();
    const intent = intents.find((candidate) => heldReplyId !== null && candidate.held_reply_id === heldReplyId) ?? intents[0];
    if (!intent) return null;
    return {
      state: intent.state,
      trigger: intent.trigger,
      authorKind: intent.author_kind,
      haltReason: intent.halt_reason,
      email: intent.provider_message_id ? await this.harness.spooledEmail(intent.provider_message_id) : null,
    };
  }
}

// ── Seeding ──────────────────────────────────────────────────────────

/**
 * The operator, their organization and workspace: registered on a fresh database, found again on a
 * later run (the open-source edition admits one organization, so a second registration is refused).
 */
const ensureOperator = async (deps: Deps, company: EmailMailboxHarnessOptions["company"]): Promise<Operator> => {
  const db = deps.connectorDb.kysely;
  const existing = await db.selectFrom("users as u")
    .innerJoin("account_memberships as am", "am.user_id", "u.id")
    .innerJoin("workspaces as w", "w.account_id", "am.account_id")
    .select(["u.id as userId", "am.account_id as accountId", "w.id as workspaceId"])
    .where("u.email", "=", company.operatorEmail.toLowerCase())
    .orderBy("w.created_at")
    .limit(1)
    .executeTakeFirst();
  if (existing) return existing;
  const registration = await deps.authService.register({
    email: company.operatorEmail,
    password: `Harness-${randomUUID()}`,
    organizationName: company.name,
    displayName: company.operatorName,
  });
  return { userId: registration.userId, accountId: registration.accountId, workspaceId: registration.workspaceId };
};

/** The workspace's default agent, named and instructed, with that configuration published. */
const ensurePublishedAgent = async (deps: Deps, workspaceId: string, agent: EmailMailboxHarnessOptions["agent"]): Promise<string> => {
  const { id: agentId } = await deps.agentService.resolve(workspaceId);
  await deps.agentService.update(workspaceId, agentId, { name: agent.name, customInstruction: agent.instruction });
  const state = await deps.agentRevisionService.state(workspaceId, agentId);
  if (state.status === "draft_clean") return agentId;
  const candidate = await deps.agentRevisionService.createCandidate(workspaceId, agentId, state.draft.generation);
  await deps.agentRevisionService.publish(workspaceId, agentId, null, {
    revisionId: candidate.id,
    expectedDraftGeneration: state.draft.generation,
    expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
    idempotencyKey: `email-behaviour-${candidate.id}`,
  });
  return agentId;
};

/** Reconciles the workspace's documents with the corpus by content hash, then processes them in-process until each is ready. */
const seedCorpus = async (deps: Deps, operator: Operator, documents: readonly CorpusDocument[], timeoutMs: number): Promise<void> => {
  const db = deps.connectorDb.kysely;
  const ids = await reconcileCorpus({
    list: () => db
      .selectFrom("documents")
      .select(["id as documentId", "external_document_id as externalDocumentId"])
      .where("workspace_id", "=", operator.workspaceId)
      .execute(),
    ingest: async (document) => (await deps.documentIngestionService.ingest({
      workspaceId: operator.workspaceId,
      accountId: operator.accountId,
      title: document.title,
      content: document.content,
      externalDocumentId: document.externalDocumentId,
    })).documentId,
    remove: (documentId) => deps.documentDeletionService.delete({ workspaceId: operator.workspaceId, documentId }),
  }, documents);
  const pending = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const processed = await deps.documentProcessingWorker.runOnce();
    for (const documentId of [...pending]) {
      const document = await deps.documentIngestionService.getDocument(operator.workspaceId, documentId);
      if (document.status === "ready") pending.delete(documentId);
      else if (document.status === "failed") throw new Error(`Corpus document ${documentId} failed processing`);
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline) throw new Error(`Corpus documents not ready within ${timeoutMs}ms: ${[...pending].join(", ")}`);
    if (!processed) await sleep(500);
  }
};

/** Registers the sending domain and verifies it, as `email:dev verify-domain` and the settings card's check do. */
const verifySendingDomain = async (deps: Deps, operator: Operator, spoolDir: string, domainName: string) => {
  const channel = deps.emailChannel;
  if (!channel) throw new Error("The email channel is not composed");
  const actor = { userId: operator.userId, accountId: operator.accountId };
  const added = await channel.sendingDomains.add(actor, operator.workspaceId, domainName);
  if (added.sending.status !== "verified") {
    await new LocalEmailDomainProvisioner({ spoolDir }).markVerified(added.domain);
    const verified = await channel.sendingDomains.verify(actor, operator.workspaceId, added.id);
    if (verified.sending.status !== "verified") throw new Error(`Sending domain ${added.domain} did not verify: ${verified.sending.status}`);
  }
  return { id: added.id, name: added.domain };
};

const shutdown = async (deps: Deps): Promise<void> => {
  await deps.applicationModules.shutdownAll().catch(() => undefined);
  await deps.realtimePublisherLifecycle.shutdown().catch(() => undefined);
  await deps.connectorDb.close().catch(() => undefined);
};
