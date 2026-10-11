import { describe, expect, it, vi } from "vitest";

import { EventLogReader } from "../../../src/modules/emailChannel/public.js";
import type { EventLogEntry } from "../../../src/modules/emailChannel/persistence/emailInboundRepository.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-03T12:00:00.000Z");

const entry = (patch: Partial<EventLogEntry>): EventLogEntry => ({
  id: "99999999-9999-4999-8999-999999999999",
  createdAt: now,
  state: "done",
  classification: "person",
  disposition: "ingest_only",
  dispositionReason: "operator_only_mailbox",
  senderAddress: "person@example.org",
  senderDisplayName: "Pat",
  subject: "Hello",
  authResults: { spf: "pass", dkim: "fail", dmarc: "pass" },
  spamVerdict: "unknown",
  conversationId: null,
  threadConflict: false,
  hasRaw: true,
  mailboxId: null,
  ...patch,
});

const setup = () => {
  const mailboxes = new InMemoryEmailMailboxes(() => now);
  const mailbox = mailboxes.seed({ workspaceId, domainId: "d", address: "support@customer.test", lastReceivedAt: now });
  const deliveries = {
    listMailboxLog: vi.fn(async () => ({ entries: [entry({}), entry({ state: "resolved", authResults: {} }), entry({ state: "failed" })], nextCursor: "cursor-id" })),
    countMailboxEvents: vi.fn(async () => ({ byDisposition: { drop: 2, ingest_only: 5 }, failed: 1 })),
    countWorkspaceEvents: vi.fn(async (): Promise<Array<{ mailboxId: string | null; byDisposition: Record<string, number>; failed: number }>> => []),
    listWorkspaceLog: vi.fn(async () => ({ entries: [entry({ dispositionReason: "no_mailbox", disposition: "drop" })], nextCursor: null })),
    findLogEntry: vi.fn(async (): Promise<EventLogEntry | null> => null),
  };
  const reader = new EventLogReader({ mailboxes, deliveries, clock: () => now });
  return { reader, deliveries, mailbox, mailboxes };
};

describe("EventLogReader", () => {
  it("maps deliveries to event log entries, showing an in-flight reservation as fetched", async () => {
    const { reader, mailbox } = setup();
    const page = await reader.list(workspaceId, mailbox.id, {});
    expect(page.nextCursor).toBe("cursor-id");
    expect(page.items[0]).toEqual({
      id: "99999999-9999-4999-8999-999999999999",
      createdAt: now.toISOString(),
      state: "done",
      classification: "person",
      disposition: "ingest_only",
      reason: "operator_only_mailbox",
      sender: { address: "person@example.org", displayName: "Pat" },
      subject: "Hello",
      auth: { spf: "pass", dkim: "fail", dmarc: "pass" },
      spamVerdict: "unknown",
      conversationId: null,
      threadConflict: false,
      hasRaw: true,
      retryable: false,
      mailboxId: null,
    });
    expect(page.items[1]).toMatchObject({ state: "fetched", auth: { spf: "unknown", dkim: "unknown", dmarc: "unknown" } });
    expect(page.items[2]).toMatchObject({ state: "failed", retryable: true });
  });

  it("bounds the page size, validates the cursor and widens the fetched filter", async () => {
    const { reader, deliveries, mailbox } = setup();
    await reader.list(workspaceId, mailbox.id, {});
    await reader.list(workspaceId, mailbox.id, { limit: 500, state: "fetched", disposition: "drop" });
    await reader.list(workspaceId, mailbox.id, { limit: 0, cursor: "99999999-9999-4999-8999-999999999999", state: "failed" });
    expect(deliveries.listMailboxLog.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { cursor: null, limit: 50, disposition: null, states: null },
      { cursor: null, limit: 100, disposition: "drop", states: ["fetched", "resolved"] },
      { cursor: "99999999-9999-4999-8999-999999999999", limit: 1, disposition: null, states: ["failed"] },
    ]);
    const error = await reader.list(workspaceId, mailbox.id, { cursor: "not-a-cursor" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 400, code: "invalid_cursor" });
  });

  it("answers 404 for a mailbox outside the workspace", async () => {
    const { reader, mailbox } = setup();
    const error = await reader.list("22222222-2222-4222-8222-222222222222", mailbox.id, {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("lists the workspace's log, mail no mailbox matched included, optionally narrowed to one mailbox", async () => {
    const { reader, deliveries, mailbox } = setup();

    const page = await reader.listWorkspace(workspaceId, { limit: 20, state: "fetched" });
    await reader.listWorkspace(workspaceId, { mailboxId: mailbox.id, disposition: "drop" });

    expect(page).toEqual({ items: [expect.objectContaining({ mailboxId: null, reason: "no_mailbox", disposition: "drop" })], nextCursor: null });
    expect(deliveries.listWorkspaceLog.mock.calls).toEqual([
      [workspaceId, { mailboxId: null, cursor: null, limit: 20, disposition: null, states: ["fetched", "resolved"] }],
      [workspaceId, { mailboxId: mailbox.id, cursor: null, limit: 50, disposition: "drop", states: null }],
    ]);
    const error = await reader.listWorkspace(workspaceId, { cursor: "not-a-cursor" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 400, code: "invalid_cursor" });
  });

  it("reads one delivery of the workspace whether or not a mailbox received it", async () => {
    const { reader, deliveries } = setup();
    deliveries.findLogEntry.mockResolvedValueOnce(entry({ dispositionReason: "no_mailbox" }));

    expect(await reader.get(workspaceId, "99999999-9999-4999-8999-999999999999")).toMatchObject({ mailboxId: null, reason: "no_mailbox" });
    await expect(reader.get(workspaceId, "99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("summarizes a window of the mailbox's events", async () => {
    const { reader, deliveries, mailbox } = setup();
    expect(await reader.summarize(workspaceId, mailbox.id, 24)).toEqual({
      mailboxId: mailbox.id,
      window: "24h",
      byDisposition: { drop: 2, ingest_only: 5 },
      failed: 1,
      lastReceivedAt: now.toISOString(),
    });
    expect(deliveries.countMailboxEvents).toHaveBeenCalledWith(mailbox.id, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  });

  it("summarizes a window of the whole workspace: each active mailbox, mail no mailbox received, and removed mailboxes' retained events", async () => {
    const { reader, deliveries, mailbox, mailboxes } = setup();
    const quiet = mailboxes.seed({ workspaceId, domainId: "d", address: "sales@customer.test", lastReceivedAt: null });
    const removed = mailboxes.seed({ workspaceId, domainId: "d", address: "old@customer.test", removedAt: now });
    const alsoRemoved = mailboxes.seed({ workspaceId, domainId: "d", address: "older@customer.test", removedAt: now });
    deliveries.countWorkspaceEvents.mockResolvedValueOnce([
      { mailboxId: mailbox.id, byDisposition: { ingest_only: 5 }, failed: 1 },
      { mailboxId: null, byDisposition: { drop: 3, undecided: 1 }, failed: 1 },
      { mailboxId: removed.id, byDisposition: { drop: 1 }, failed: 0 },
      { mailboxId: alsoRemoved.id, byDisposition: { drop: 2, ingest_only: 1 }, failed: 1 },
    ]);

    expect(await reader.summarizeWorkspace(workspaceId, 6)).toEqual({
      window: "6h",
      mailboxes: [
        { mailboxId: mailbox.id, window: "6h", byDisposition: { ingest_only: 5 }, failed: 1, lastReceivedAt: now.toISOString() },
        { mailboxId: quiet.id, window: "6h", byDisposition: {}, failed: 0, lastReceivedAt: null },
      ],
      noMailbox: { byDisposition: { drop: 3, undecided: 1 }, failed: 1 },
      removedMailboxes: { byDisposition: { drop: 3, ingest_only: 1 }, failed: 1 },
    });
    expect(deliveries.countWorkspaceEvents).toHaveBeenCalledExactlyOnceWith(workspaceId, new Date(now.getTime() - 6 * 60 * 60 * 1000));
    expect(deliveries.countMailboxEvents).not.toHaveBeenCalled();
  });
});
