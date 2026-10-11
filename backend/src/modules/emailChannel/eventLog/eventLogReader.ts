import { AppError, notFound } from "../../../shared/domain/errors.js";
import type {
  DeliveryState,
  Disposition,
  EmailInboundRepository,
  EventLogEntry,
} from "../persistence/emailInboundRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EmailEventState = "pending" | "fetched" | "ingested" | "done" | "failed";

// A resolved delivery holds a thread reservation but no message yet; operators see it as fetched.
const VIEW_STATE: Readonly<Record<DeliveryState, EmailEventState>> = {
  pending: "pending",
  fetched: "fetched",
  resolved: "fetched",
  ingested: "ingested",
  done: "done",
  failed: "failed",
};
const FILTER_STATES: Readonly<Record<EmailEventState, readonly DeliveryState[]>> = {
  pending: ["pending"],
  fetched: ["fetched", "resolved"],
  ingested: ["ingested"],
  done: ["done"],
  failed: ["failed"],
};

export interface EmailEventView {
  id: string;
  createdAt: string;
  state: EmailEventState;
  classification: string | null;
  disposition: Disposition | null;
  reason: string | null;
  sender: { address: string | null; displayName: string | null };
  subject: string | null;
  auth: { spf: string; dkim: string; dmarc: string };
  spamVerdict: "spam" | "not_spam" | "unknown";
  conversationId: string | null;
  threadConflict: boolean;
  hasRaw: boolean;
  retryable: boolean;
  /** The mailbox that received it; null for mail accepted for an address no mailbox has. */
  mailboxId: string | null;
}

interface EmailEventPage {
  items: EmailEventView[];
  nextCursor: string | null;
}

interface EmailEventLogSummary {
  mailboxId: string;
  window: string;
  byDisposition: Record<string, number>;
  failed: number;
  lastReceivedAt: string | null;
}

interface EmailEventCounts {
  byDisposition: Record<string, number>;
  failed: number;
}

/**
 * A window of the workspace's whole event log: each active mailbox's summary, and the deliveries
 * none of them received, which no mailbox summary carries.
 */
interface EmailWorkspaceEventLogSummary {
  window: string;
  mailboxes: EmailEventLogSummary[];
  /** Mail accepted for an address no mailbox has. */
  noMailbox: EmailEventCounts;
  /** Removed mailboxes' retained deliveries. */
  removedMailboxes: EmailEventCounts;
}

interface EventLogQuery {
  cursor?: string | null;
  limit?: number;
  disposition?: Disposition | null;
  state?: EmailEventState | null;
}

const readAuth = (value: unknown): EmailEventView["auth"] => {
  const results = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const verdict = (key: string): string => (typeof results[key] === "string" ? results[key] : "unknown");
  return { spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc") };
};

const toEventView = (entry: EventLogEntry): EmailEventView => ({
  id: entry.id,
  createdAt: entry.createdAt.toISOString(),
  state: VIEW_STATE[entry.state],
  classification: entry.classification,
  disposition: entry.disposition,
  reason: entry.dispositionReason,
  sender: { address: entry.senderAddress, displayName: entry.senderDisplayName },
  subject: entry.subject,
  auth: readAuth(entry.authResults),
  spamVerdict: entry.spamVerdict,
  conversationId: entry.conversationId,
  threadConflict: entry.threadConflict,
  hasRaw: entry.hasRaw,
  retryable: entry.state === "failed",
  mailboxId: entry.mailboxId,
});

export const eventNotFound = (): AppError => notFound("Email event was not found");

const summaryOf = (mailbox: EmailMailboxRecord, windowHours: number, counts: EmailEventCounts): EmailEventLogSummary => ({
  mailboxId: mailbox.id,
  window: `${windowHours}h`,
  byDisposition: { ...counts.byDisposition },
  failed: counts.failed,
  lastReceivedAt: mailbox.lastReceivedAt?.toISOString() ?? null,
});

const NO_EVENTS: EmailEventCounts = { byDisposition: {}, failed: 0 };

const addCounts = (total: EmailEventCounts, counts: EmailEventCounts): EmailEventCounts => {
  const byDisposition = { ...total.byDisposition };
  for (const [disposition, count] of Object.entries(counts.byDisposition)) {
    byDisposition[disposition] = (byDisposition[disposition] ?? 0) + count;
  }
  return { byDisposition, failed: total.failed + counts.failed };
};

const pageSize = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_PAGE_SIZE
    : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));

const pageQuery = (query: EventLogQuery) => {
  const cursor = query.cursor ?? null;
  if (cursor !== null && !UUID.test(cursor)) throw new AppError(400, "invalid_cursor", "The event log cursor is not valid.");
  return {
    cursor,
    limit: pageSize(query.limit),
    disposition: query.disposition ?? null,
    states: query.state ? FILTER_STATES[query.state] : null,
  };
};

/**
 * The event log (FR-016): every accepted delivery, newest first, per active mailbox with its
 * summary, and per workspace — where mail accepted for an address no mailbox has, and a removed
 * mailbox's retained events, stay readable.
 */
export class EventLogReader {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "findActive" | "listActive">;
    deliveries: Pick<
      EmailInboundRepository,
      "listMailboxLog" | "listWorkspaceLog" | "countMailboxEvents" | "countWorkspaceEvents" | "findLogEntry"
    >;
    clock: () => Date;
  }) {}

  /** An active mailbox's log. */
  async list(workspaceId: string, mailboxId: string, query: EventLogQuery): Promise<EmailEventPage> {
    const page = pageQuery(query);
    await this.requireMailbox(workspaceId, mailboxId);
    const { entries, nextCursor } = await this.deps.deliveries.listMailboxLog(mailboxId, page);
    return { items: entries.map(toEventView), nextCursor };
  }

  /** The workspace's log, or one of its mailboxes' — removed ones included — when `mailboxId` is set. */
  async listWorkspace(workspaceId: string, query: EventLogQuery & { mailboxId?: string | null }): Promise<EmailEventPage> {
    const page = pageQuery(query);
    const { entries, nextCursor } = await this.deps.deliveries.listWorkspaceLog(workspaceId, { ...page, mailboxId: query.mailboxId ?? null });
    return { items: entries.map(toEventView), nextCursor };
  }

  /** One delivery of the workspace, as its event log shows it. */
  async get(workspaceId: string, deliveryId: string): Promise<EmailEventView> {
    const entry = await this.deps.deliveries.findLogEntry(workspaceId, deliveryId);
    if (!entry) throw eventNotFound();
    return toEventView(entry);
  }

  /** Counts by disposition, and failures, over the last `windowHours`. */
  async summarize(workspaceId: string, mailboxId: string, windowHours: number): Promise<EmailEventLogSummary> {
    const mailbox = await this.requireMailbox(workspaceId, mailboxId);
    const counts = await this.deps.deliveries.countMailboxEvents(mailbox.id, this.windowStart(windowHours));
    return summaryOf(mailbox, windowHours, counts);
  }

  /**
   * As {@link summarize} for every active mailbox at once, with the rest of the workspace's log in
   * the window: mail accepted for an address no mailbox has, and removed mailboxes' retained events.
   */
  async summarizeWorkspace(workspaceId: string, windowHours: number): Promise<EmailWorkspaceEventLogSummary> {
    const [mailboxes, counts] = await Promise.all([
      this.deps.mailboxes.listActive(workspaceId),
      this.deps.deliveries.countWorkspaceEvents(workspaceId, this.windowStart(windowHours)),
    ]);
    const countsByMailbox = new Map(counts.map((entry) => [entry.mailboxId, entry]));
    const active = new Set(mailboxes.map((mailbox) => mailbox.id));
    return {
      window: `${windowHours}h`,
      mailboxes: mailboxes.map((mailbox) => summaryOf(mailbox, windowHours, countsByMailbox.get(mailbox.id) ?? NO_EVENTS)),
      noMailbox: counts.filter((entry) => entry.mailboxId === null).reduce(addCounts, NO_EVENTS),
      removedMailboxes: counts
        .filter((entry) => entry.mailboxId !== null && !active.has(entry.mailboxId))
        .reduce(addCounts, NO_EVENTS),
    };
  }

  private windowStart(windowHours: number): Date {
    return new Date(this.deps.clock().getTime() - windowHours * HOUR_MS);
  }

  private async requireMailbox(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord> {
    const mailbox = await this.deps.mailboxes.findActive(workspaceId, mailboxId);
    if (!mailbox) throw notFound("Mailbox was not found");
    return mailbox;
  }
}
