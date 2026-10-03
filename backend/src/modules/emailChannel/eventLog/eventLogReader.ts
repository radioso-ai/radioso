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

interface EmailEventView {
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
});

const pageSize = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_PAGE_SIZE
    : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));

/** A mailbox's event log (FR-016): every accepted delivery, newest first, and its summary. */
export class EventLogReader {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "findActive">;
    deliveries: Pick<EmailInboundRepository, "listMailboxLog" | "countMailboxEvents">;
    clock: () => Date;
  }) {}

  async list(workspaceId: string, mailboxId: string, query: EventLogQuery): Promise<EmailEventPage> {
    const cursor = query.cursor ?? null;
    if (cursor !== null && !UUID.test(cursor)) throw new AppError(400, "invalid_cursor", "The event log cursor is not valid.");
    await this.requireMailbox(workspaceId, mailboxId);
    const page = await this.deps.deliveries.listMailboxLog(mailboxId, {
      cursor,
      limit: pageSize(query.limit),
      disposition: query.disposition ?? null,
      states: query.state ? FILTER_STATES[query.state] : null,
    });
    return { items: page.entries.map(toEventView), nextCursor: page.nextCursor };
  }

  /** Counts by disposition, and failures, over the last `windowHours`. */
  async summarize(workspaceId: string, mailboxId: string, windowHours: number): Promise<EmailEventLogSummary> {
    const mailbox = await this.requireMailbox(workspaceId, mailboxId);
    const since = new Date(this.deps.clock().getTime() - windowHours * HOUR_MS);
    const counts = await this.deps.deliveries.countMailboxEvents(mailbox.id, since);
    return {
      mailboxId: mailbox.id,
      window: `${windowHours}h`,
      byDisposition: counts.byDisposition,
      failed: counts.failed,
      lastReceivedAt: mailbox.lastReceivedAt?.toISOString() ?? null,
    };
  }

  private async requireMailbox(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord> {
    const mailbox = await this.deps.mailboxes.findActive(workspaceId, mailboxId);
    if (!mailbox) throw notFound("Mailbox was not found");
    return mailbox;
  }
}
