import { vi } from "vitest";

import type { ActionHandlerContext } from "../../src/modules/chat/contracts/index.js";
import type {
  DeliveryFailureLockPort,
  DeliveryFailureRecord,
  DeliveryFailureRecorderPort,
} from "../../src/modules/customerReplyDelivery/public.js";
import {
  EmailHeldReplyChannelScope,
  EmailSendActionHandler,
  emailMailboxPolicyRef,
  emailSendKey,
  ProviderDeliveryEvents,
  ProviderSendAttempt,
  SendCommitment,
  SendIntentWriter,
  SendReconciler,
  type EmailSendActionPayload,
  type EmailSendScope,
  type EmailSendUnitOfWork,
} from "../../src/modules/emailChannel/public.js";
import { heldReplyEventSources } from "../../src/modules/handoff/heldReplies/heldReplyState.js";
import type { HeldReplyState } from "../../src/modules/handoff/public.js";
import type { EmailMessage, EmailSendResult, SentEmailStatus } from "../../src/modules/mail/public.js";
import type {
  EmailSendIntentRecord,
  EmailSendIntentRepository,
  FencedWriteOutcome,
  SendDeliveryState,
  SendIntentTransitionOutcome,
} from "../../src/modules/emailChannel/persistence/emailSendIntentRepository.js";
import {
  isTerminalSendIntentState,
  nextSendIntentState,
  type SendIntentEvent,
  type SendIntentSnapshot,
} from "../../src/modules/emailChannel/outbound/sendIntentTransitions.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes, InMemoryEmailThreads } from "./inMemoryEmailChannel.js";

type Args<T extends (...args: never[]) => unknown> = Parameters<T>;
type Clock = () => Date;

const RECONCILABLE = new Set(["queued", "accepted", "uncertain"]);

const snapshotOf = (intent: EmailSendIntentRecord): SendIntentSnapshot => ({
  state: intent.state,
  haltReason: intent.haltReason,
  providerMessageId: intent.providerMessageId,
  deliveredRfcMessageId: intent.deliveredRfcMessageId,
  failureCode: intent.failureCode,
  requestFrozen: intent.request !== null,
  outcomeUnknown: intent.outcomeUnknown,
  uncertainResolution: intent.uncertainResolution,
  uncertainResolvedByUserId: intent.uncertainResolvedByUserId,
});

const copy = (intent: EmailSendIntentRecord): EmailSendIntentRecord => structuredClone(intent);

/**
 * In-memory `email_send_intents` with the repository's semantics: the state machine applied under
 * the `version` fence, the bookkeeping timestamps, and the leased reconcile claim. Every write is
 * appended to `log`, and `beforeWrite` lets a test land a competing writer first.
 */
export class InMemoryEmailSendIntents implements Pick<
  EmailSendIntentRepository,
  | "materialize"
  | "findById"
  | "findByIdempotencyKey"
  | "transition"
  | "freezeRequest"
  | "recordDeliveredMessageId"
  | "claimDueForReconcile"
  | "findByProviderMessageId"
  | "findByOutboundRfcMessageIds"
  | "recordComplaint"
  | "listDeliveryStates"
  | "listByMessageId"
  | "listMessagesSentThrough"
> {
  readonly rows = new Map<string, EmailSendIntentRecord>();
  readonly log: string[] = [];
  /** Runs before each fenced write reads the row; a test may move the intent here. */
  beforeWrite: ((id: string) => Promise<void> | void) | null = null;

  constructor(private readonly clock: Clock, private readonly threads?: Pick<InMemoryEmailThreads, "index">) {}

  async materialize(input: Args<EmailSendIntentRepository["materialize"]>[0]) {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { intent: existing, created: false };
    const now = this.clock();
    const record: EmailSendIntentRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      heldReplyId: input.heldReplyId,
      idempotencyKey: input.idempotencyKey,
      authorKind: input.authorKind,
      trigger: input.trigger,
      state: "queued",
      version: 0,
      haltReason: null,
      authority: { ...input.authority },
      request: null,
      provider: input.provider,
      providerMessageId: null,
      suppliedRfcMessageId: input.suppliedRfcMessageId,
      deliveredRfcMessageId: null,
      failureCode: null,
      outcomeUnknown: false,
      uncertainResolution: null,
      uncertainResolvedByUserId: null,
      firstAttemptAt: null,
      outcomeUnknownSince: null,
      nextReconcileAt: null,
      reconcileLeaseUntil: null,
      acceptedAt: null,
      settledAt: null,
      complainedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    this.log.push("materialize");
    return { intent: copy(record), created: true };
  }

  /** Seeds an intent directly, for tests that start mid-lifecycle. */
  seed(record: EmailSendIntentRecord): EmailSendIntentRecord {
    this.rows.set(record.id, copy(record));
    return copy(record);
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? copy(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return row ? copy(row) : null;
  }

  async listByMessageId(messageId: string) {
    return [...this.rows.values()]
      .filter((row) => row.messageId === messageId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(copy);
  }

  async listMessagesSentThrough(intent: Pick<EmailSendIntentRecord, "id" | "conversationId" | "messageId">) {
    const delivered = this.rows.get(intent.id);
    const order = (row: EmailSendIntentRecord) => [row.createdAt.getTime(), row.id] as const;
    const notAfter = (row: EmailSendIntentRecord) => {
      if (!delivered) return false;
      const [time, id] = order(row);
      const [deliveredTime, deliveredId] = order(delivered);
      return time < deliveredTime || (time === deliveredTime && id <= deliveredId);
    };
    const newest = new Map<string, EmailSendIntentRecord>();
    for (const row of [...this.rows.values()].filter((candidate) => candidate.conversationId === intent.conversationId)) {
      const current = newest.get(row.messageId);
      if (!current || order(row) > order(current)) newest.set(row.messageId, row);
    }
    const vouched = [...newest.values()].filter(notAfter).map((row) => row.messageId);
    return [...new Set([intent.messageId, ...vouched])];
  }

  async findByProviderMessageId(provider: string, providerMessageId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.provider === provider && candidate.providerMessageId === providerMessageId);
    return row ? copy(row) : null;
  }

  async findByOutboundRfcMessageIds(mailboxId: string, rfcMessageIds: readonly string[]) {
    const ids = new Set((this.threads?.index ?? [])
      .filter((entry) => entry.mailboxId === mailboxId && entry.direction === "outbound" && rfcMessageIds.includes(entry.rfcMessageId))
      .map((entry) => entry.sendIntentId)
      .filter((id): id is string => typeof id === "string"));
    return [...ids].map((id) => this.rows.get(id)).filter((row): row is EmailSendIntentRecord => row !== undefined).map(copy);
  }

  async transition(id: string, expectedVersion: number, event: SendIntentEvent): Promise<SendIntentTransitionOutcome> {
    await this.beforeWrite?.(id);
    const current = this.rows.get(id);
    if (!current) return { outcome: "not_found" };
    if (current.version !== expectedVersion) return { outcome: "conflict", current: copy(current) };
    const result = nextSendIntentState(snapshotOf(current), event);
    if ("ignored" in result) return { outcome: "ignored", reason: result.ignored, intent: copy(current) };
    const { next: { requestFrozen: _requestFrozen, ...next }, effects } = result;
    const now = this.clock();
    const schedule = effects.find((effect) => effect.kind === "schedule_reconcile");
    const settles = isTerminalSendIntentState(next.state);
    const updated: EmailSendIntentRecord = {
      ...current,
      ...next,
      nextReconcileAt: schedule && schedule.kind === "schedule_reconcile" ? new Date(now.getTime() + schedule.afterSeconds * 1000) : null,
      reconcileLeaseUntil: null,
      outcomeUnknownSince: next.outcomeUnknown && current.outcomeUnknownSince === null ? now : current.outcomeUnknownSince,
      acceptedAt: next.providerMessageId !== null && current.providerMessageId === null ? now : current.acceptedAt,
      settledAt: settles ? now : current.settledAt,
      request: settles && current.request !== null ? { ...current.request, body: null } : current.request,
      version: expectedVersion + 1,
      updatedAt: now,
    };
    this.rows.set(id, updated);
    this.log.push(`transition:${event.kind}:${updated.state}`);
    return { outcome: "applied", intent: copy(updated), effects };
  }

  async freezeRequest(
    id: string,
    expectedVersion: number,
    request: Args<EmailSendIntentRepository["freezeRequest"]>[2],
  ): Promise<FencedWriteOutcome> {
    await this.beforeWrite?.(id);
    const current = this.rows.get(id);
    if (!current) return { outcome: "not_found" };
    if (current.version !== expectedVersion || current.state !== "queued" || current.request !== null) {
      return { outcome: "conflict", current: copy(current) };
    }
    const updated: EmailSendIntentRecord = {
      ...current,
      request: structuredClone(request),
      firstAttemptAt: this.clock(),
      version: expectedVersion + 1,
      updatedAt: this.clock(),
    };
    this.rows.set(id, updated);
    this.log.push("freezeRequest");
    return { outcome: "applied", intent: copy(updated) };
  }

  async recordDeliveredMessageId(id: string, input: Args<EmailSendIntentRepository["recordDeliveredMessageId"]>[1]) {
    const current = this.rows.get(id);
    if (!current || current.providerMessageId !== input.providerMessageId || current.deliveredRfcMessageId !== null) return false;
    this.rows.set(id, { ...current, deliveredRfcMessageId: input.deliveredRfcMessageId, version: current.version + 1 });
    this.log.push("recordDeliveredMessageId");
    return true;
  }

  async claimDueForReconcile(input: { limit: number; leaseSeconds: number }) {
    const now = this.clock().getTime();
    const due = [...this.rows.values()]
      .filter((row) => RECONCILABLE.has(row.state)
        && row.nextReconcileAt !== null
        && row.nextReconcileAt.getTime() <= now
        && (row.reconcileLeaseUntil === null || row.reconcileLeaseUntil.getTime() < now))
      .sort((left, right) => left.nextReconcileAt!.getTime() - right.nextReconcileAt!.getTime())
      .slice(0, input.limit);
    for (const row of due) {
      this.rows.set(row.id, { ...row, reconcileLeaseUntil: new Date(now + input.leaseSeconds * 1000) });
    }
    return due.map((row) => copy(this.rows.get(row.id)!));
  }

  async recordComplaint(id: string) {
    const current = this.rows.get(id);
    if (!current || current.complainedAt !== null) return false;
    this.rows.set(id, { ...current, complainedAt: this.clock(), version: current.version + 1 });
    this.log.push("recordComplaint");
    return true;
  }

  async listDeliveryStates(conversationId: string): Promise<SendDeliveryState[]> {
    const newest = new Map<string, SendDeliveryState>();
    for (const row of [...this.rows.values()].filter((candidate) => candidate.conversationId === conversationId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
      newest.set(row.messageId, { messageId: row.messageId, state: row.state, failureCode: row.failureCode, createdAt: row.createdAt });
    }
    return [...newest.values()];
  }
}

interface FailureRow {
  id: string;
  workspaceId: string;
  conversationId: string;
  messageId: string | null;
  provider: string;
  kind: string;
  detailCode: string | null;
  cleared: string | null;
}

/** In-memory delivery failures with the recorder's rules: one open failure per message. */
export class InMemoryDeliveryFailures implements DeliveryFailureRecorderPort, DeliveryFailureLockPort {
  readonly rows: FailureRow[] = [];

  open: DeliveryFailureRecorderPort["open"] = async (input) => {
    if (this.openFor(input.messageId)) return;
    this.rows.push({ id: `failure-${this.rows.length + 1}`, ...input, cleared: null });
  };

  retarget: DeliveryFailureRecorderPort["retarget"] = async (input) => {
    const row = this.openFor(input.messageId);
    if (row) Object.assign(row, { kind: input.kind, detailCode: input.detailCode });
  };

  clear: DeliveryFailureRecorderPort["clear"] = async (input) => {
    const open = this.rows.filter((row) => row.cleared === null && (input.reason === "operator_resolved"
      ? row.id === input.failureId
      : row.conversationId === input.conversationId && row.messageId !== null && input.messageIds.includes(row.messageId)));
    for (const row of open) row.cleared = input.reason;
    return open.length;
  };

  lockOpen: DeliveryFailureLockPort["lockOpen"] = async (input) => {
    const row = this.rows.find((candidate) => candidate.cleared === null && candidate.id === input.failureId && candidate.workspaceId === input.workspaceId);
    return row ? this.recordOf(row) : null;
  };

  /** The failure as the operator surfaces read it, for a teammate's decision on it. */
  recordOf(row: FailureRow): DeliveryFailureRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      conversationId: row.conversationId,
      messageId: row.messageId,
      provider: row.provider,
      kind: row.kind as DeliveryFailureRecord["kind"],
      detailCode: row.detailCode,
      openedAt: new Date(0),
      clearedAt: row.cleared === null ? null : new Date(0),
      clearedByUserId: null,
      clearReason: row.cleared as DeliveryFailureRecord["clearReason"],
    };
  }

  openFor(messageId: string | null): FailureRow | undefined {
    return this.rows.find((row) => row.cleared === null && row.messageId === messageId);
  }
}

/**
 * Runs each unit of work over the in-memory stores, counting the ones open, so a test can assert
 * that no transaction is held across a provider call.
 */
export const inMemoryEmailSendUnitOfWork = (scope: EmailSendScope): EmailSendUnitOfWork & { readonly openUnits: number; runs: number } => {
  const state = { openUnits: 0, runs: 0 };
  return {
    get openUnits() {
      return state.openUnits;
    },
    get runs() {
      return state.runs;
    },
    set runs(value: number) {
      state.runs = value;
    },
    async run(work) {
      state.openUnits += 1;
      state.runs += 1;
      try {
        return await work(scope);
      } finally {
        state.openUnits -= 1;
      }
    },
  };
};

// ── Send-path harness ───────────────────────────────────────────────

export const SEND_IDS = {
  workspace: "11111111-1111-4111-8111-111111111111",
  conversation: "66666666-6666-4666-8666-666666666666",
  message: "77777777-7777-4777-8777-777777777777",
  heldReply: "88888888-8888-4888-8888-888888888888",
  /** The agent message an automatic send's materialization writes. */
  autoMessage: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

interface FakeMessage {
  id: string;
  conversationId: string;
  content: string;
  source: string | null;
}

/**
 * The send path over in-memory stores and a scripted driver: the real handler, attempt, writer,
 * reconciler and provider-event processor, with a seeded verified domain, a mailbox, a thread link
 * whose latest inbound message carries a `References` chain, and an operator's message.
 */
export const createSendPathHarness = (options: { now?: Date; sendingStatus?: "pending" | "verified" } = {}) => {
  let now = options.now ?? new Date("2026-10-04T09:00:00.000Z");
  const clock = () => new Date(now);
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const threads = new InMemoryEmailThreads([], clock);
  const intents = new InMemoryEmailSendIntents(clock, threads);
  const failures = new InMemoryDeliveryFailures();
  const unitOfWork = inMemoryEmailSendUnitOfWork({ intents, threads, failures });
  const metrics = { incrementCounter: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const drains = { requestDrain: vi.fn(async () => undefined) };
  const openUnitsAtSend: number[] = [];
  const sentMessages: EmailMessage[] = [];
  const driver = {
    send: vi.fn(async (message: EmailMessage): Promise<EmailSendResult> => {
      openUnitsAtSend.push(unitOfWork.openUnits);
      sentMessages.push(structuredClone(message));
      return { dispatched: true, providerMessageId: "re_provider_1", deliveredMessageId: null };
    }),
    lookup: vi.fn(async (_providerMessageId: string): Promise<SentEmailStatus | null> => null),
  };
  const messages = new Map<string, FakeMessage>();

  const domain = domains.seed({ workspaceId: SEND_IDS.workspace, domain: "customer.test", sendingStatus: options.sendingStatus ?? "verified" });
  const mailbox = mailboxes.seed({ workspaceId: SEND_IDS.workspace, domainId: domain.id, address: "support@customer.test" });
  threads.links.set(SEND_IDS.conversation, {
    conversationId: SEND_IDS.conversation,
    workspaceId: SEND_IDS.workspace,
    mailboxId: mailbox.id,
    threadKey: "99999999-9999-4999-8999-999999999999",
    threadToken: "THREADTOKENABCDEFGH234567",
    participantAddress: "pat@example.org",
    latestSubject: "Order 42",
    latestParticipantDisplayName: "Pat",
    latestCcAddresses: [],
    latestInboundAt: clock(),
    autoSendsSinceRenewal: 2,
    budgetRenewedAt: null,
    reviewRevision: 0,
    reviewCompletedRevision: 0,
    reviewDueAt: null,
    reviewPolicyVersion: null,
    reviewAttempts: 0,
  });
  threads.index.push({
    workspaceId: SEND_IDS.workspace,
    mailboxId: mailbox.id,
    conversationId: SEND_IDS.conversation,
    messageId: "55555555-5555-4555-8555-555555555555",
    direction: "inbound",
    origin: "inbound",
    rfcMessageId: "<second@example.org>",
    subject: "Re: Order 42",
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: "delivery-2",
  });
  threads.referencesByDelivery.set("delivery-2", ["<root@example.org>", "<first@example.org>"]);
  messages.set(SEND_IDS.message, {
    id: SEND_IDS.message,
    conversationId: SEND_IDS.conversation,
    content: "Your order ships on Monday.",
    source: "human_agent",
  });

  const writer = new SendIntentWriter({ unitOfWork, metrics, logger });
  const attempt = new ProviderSendAttempt({ driver, writer, unitOfWork, drains, metrics, logger, clock });
  let ids = 0;
  const createId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++ids).padStart(12, "0")}`;
  /** Conversation ownership; a conversation missing here is the AI's, at version 0. */
  const owners = new Map<string, { state: "ai_owned" | "human_owned"; version: number }>();
  const ownership = { load: async (conversationId: string) => owners.get(conversationId) ?? null };

  // Stands in for handoff's materialize transaction (research B9) over email's real scope: a held
  // reply still in a state the held-reply machine materializes from is authorized, then written as
  // the agent's message with its intent; an unauthorized one returns to `pending` with no message.
  const autoReply = { state: "queued_auto" as HeldReplyState, text: "Your order ships on Monday." };
  const channelScope = new EmailHeldReplyChannelScope({
    mailboxes,
    domains,
    reviews: threads,
    autoSend: { threads, ownership, intents, provider: "resend", createId },
  });
  const autoReplyView = () => ({
    id: SEND_IDS.heldReply,
    conversationId: SEND_IDS.conversation,
    policyRef: emailMailboxPolicyRef(mailbox.id),
    policyVersion: mailbox.policyVersion,
    ownershipVersion: 0,
  });
  const materializeAuto = vi.fn(async (_heldReplyId: string): Promise<{ ok: true; messageId: string } | { ok: false; reason: "not_queued" | "returned_to_pending" }> => {
    if (!heldReplyEventSources("materialize").includes(autoReply.state)) return { ok: false, reason: "not_queued" };
    const verdict = await channelScope.authorizeAutoDispatch(autoReplyView());
    if (!verdict.authorized) {
      autoReply.state = "pending";
      return { ok: false, reason: "returned_to_pending" };
    }
    messages.set(SEND_IDS.autoMessage, { id: SEND_IDS.autoMessage, conversationId: SEND_IDS.conversation, content: autoReply.text, source: "ai_agent" });
    await channelScope.recordMaterialized(autoReplyView(), SEND_IDS.autoMessage);
    autoReply.state = "released";
    return { ok: true, messageId: SEND_IDS.autoMessage };
  });

  const messageReader = { findByIdAndWorkspaceId: async (_workspaceId: string, messageId: string) => messages.get(messageId) ?? null };
  // The commitment's transaction, counted with the send path's units so a test sees none open at the provider call.
  const commitment = new SendCommitment({
    unitOfWork: {
      run: (work) => unitOfWork.run(() => work({
        conversations: { lockOwnership: async ({ conversationId }) => ownership.load(conversationId) },
        mailboxes,
        domains,
        threads,
        messages: messageReader,
        intents,
      })),
    },
  });
  const handler = new EmailSendActionHandler({
    intents,
    unitOfWork,
    commitment,
    messages: messageReader,
    mailboxes,
    domains,
    ownership,
    heldReplies: { materializeAuto },
    attempt,
    writer,
    failures,
    provider: "resend",
    metrics,
    logger,
    createId,
  });
  const reconciler = new SendReconciler({ intents, mailboxes, domains, ownership, driver, attempt, writer, metrics, logger, clock });
  const deliveryEvents = new ProviderDeliveryEvents({ intents, writer, audit, metrics, logger });

  const payload = (overrides: Partial<EmailSendActionPayload> = {}): EmailSendActionPayload => ({
    version: 1,
    trigger: "operator_reply",
    mailboxId: mailbox.id,
    conversationId: SEND_IDS.conversation,
    messageId: SEND_IDS.message,
    heldReplyId: null,
    authority: { policyVersion: mailbox.policyVersion, ownershipVersion: 0, mode: mailbox.engagementMode, domainId: domain.id },
    ...overrides,
  });
  const context = (overrides: Partial<ActionHandlerContext> = {}): ActionHandlerContext => ({
    requestId: "request-1",
    workspaceId: SEND_IDS.workspace,
    accountId: null,
    conversationId: SEND_IDS.conversation,
    idempotencyKey: emailSendKey.message(SEND_IDS.message),
    attempt: 1,
    skillName: null,
    ...overrides,
  });
  /** Delivers the default operator reply's action, as the outbox worker does. */
  const deliver = (overrides: { payload?: Partial<EmailSendActionPayload>; context?: Partial<ActionHandlerContext> } = {}) =>
    handler.handle({ payload: { ...payload(overrides.payload) }, context: context(overrides.context) });
  /** The action an `auto` mailbox's publish queued for the held reply (research B9), as the outbox worker delivers it. */
  const autoAction = (attemptNumber = 1) => ({
    payload: {
      ...payload({
        trigger: "auto_reply",
        messageId: null,
        heldReplyId: SEND_IDS.heldReply,
        authority: { policyVersion: mailbox.policyVersion, ownershipVersion: 0, mode: "auto", domainId: domain.id },
      }),
    },
    context: context({ idempotencyKey: emailSendKey.heldReply(SEND_IDS.heldReply), attempt: attemptNumber }),
  });
  const deliverAuto = (attemptNumber = 1) => handler.handle(autoAction(attemptNumber));
  const onlyIntent = (): EmailSendIntentRecord => {
    const rows = [...intents.rows.values()];
    if (rows.length !== 1) throw new Error(`expected one send intent, found ${rows.length}`);
    return structuredClone(rows[0]);
  };
  const counted = (name: string) => metrics.incrementCounter.mock.calls
    .filter(([metric]) => metric === name)
    .map(([, write]) => (write as { labels: Record<string, string> }).labels);

  return {
    clock,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    domains,
    domain,
    mailboxes,
    mailbox,
    threads,
    intents,
    failures,
    unitOfWork,
    metrics,
    logger,
    audit,
    drains,
    driver,
    openUnitsAtSend,
    sentMessages,
    messages,
    writer,
    attempt,
    handler,
    reconciler,
    deliveryEvents,
    payload,
    context,
    deliver,
    autoAction,
    deliverAuto,
    autoReply,
    materializeAuto,
    owners,
    onlyIntent,
    counted,
  };
};
