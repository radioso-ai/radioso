import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalEmailDriver } from "../../../src/modules/mail/adapters/localEmailDriver.js";
import { EmailSendError, rfcMessageId, type EmailMessage } from "../../../src/modules/mail/public.js";

const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "pat@example.org",
  from: { email: "support@customer.test", name: "Support" },
  replyTo: null,
  subject: "Re: Order 42",
  text: "Your order ships on Monday.",
  kind: "channel_reply",
  idempotencyKey: "email:send:msg:77777777-7777-4777-8777-777777777777",
  threading: { messageId: rfcMessageId(`<${INTENT_ID}@customer.test>`), inReplyTo: null, references: [], autoSubmitted: null },
  ...overrides,
});

describe("LocalEmailDriver", () => {
  let spoolDir: string;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), "email-spool-"));
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it("accepts a message under the supplied Message-ID and honours its idempotency key", async () => {
    const driver = new LocalEmailDriver({ spoolDir });

    const first = await driver.send(message());
    const again = await driver.send(message());

    expect(first).toEqual({ dispatched: true, providerMessageId: expect.stringMatching(/^local-[0-9a-f]{32}$/), deliveredMessageId: `<${INTENT_ID}@customer.test>` });
    expect(again).toEqual(first);
  });

  it("refuses a different body under a used key, as the provider does", async () => {
    const driver = new LocalEmailDriver({ spoolDir });
    await driver.send(message());

    await expect(driver.send(message({ text: "Something else." }))).rejects.toMatchObject(new EmailSendError("rejected", "idempotency_body_mismatch"));
  });

  it("accepts exactly one of two different bodies raced under one key by separate drivers", async () => {
    const [first, second] = [new LocalEmailDriver({ spoolDir }), new LocalEmailDriver({ spoolDir })];

    const results = await Promise.allSettled([
      first.send(message({ text: "First body." })),
      second.send(message({ text: "Second body." })),
    ]);

    const accepted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatchObject({ outcome: "rejected", code: "idempotency_body_mismatch" });
    const winnerText = results[0]?.status === "fulfilled" ? "First body." : "Second body.";
    const spooled = await readdir(join(spoolDir, "outbound"));
    expect(spooled).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(spoolDir, "outbound", spooled[0]), "utf8")) as { message: { text: string } };
    expect(stored.message.text).toBe(winnerText);
  });

  it("gives every driver racing the same body under one key the same acceptance", async () => {
    const drivers = [new LocalEmailDriver({ spoolDir }), new LocalEmailDriver({ spoolDir }), new LocalEmailDriver({ spoolDir })];

    const results = await Promise.all(drivers.map((driver) => driver.send(message())));

    expect(new Set(results.map((result) => result.providerMessageId)).size).toBe(1);
    expect(results.every((result) => result.dispatched)).toBe(true);
    expect(await readdir(join(spoolDir, "outbound"))).toHaveLength(1);
  });

  it("replaces a message's record whole when an event is recorded, leaving no staging files", async () => {
    const [sender, recorder] = [new LocalEmailDriver({ spoolDir }), new LocalEmailDriver({ spoolDir })];
    const { providerMessageId } = await sender.send(message());

    await Promise.all([recorder.recordEvent(providerMessageId!, "delivered"), sender.lookup(providerMessageId!)]);

    expect(await sender.lookup(providerMessageId!)).toMatchObject({ lastEvent: "delivered" });
    expect(await readdir(join(spoolDir, "outbound"))).toEqual([`${providerMessageId}.json`]);
  });

  it("treats only a missing spool file as absence and surfaces any other read failure", async () => {
    const driver = new LocalEmailDriver({ spoolDir });
    const { providerMessageId } = await new LocalEmailDriver({ spoolDir: join(spoolDir, "elsewhere") }).send(message());
    await mkdir(join(spoolDir, "outbound", `${providerMessageId}.json`), { recursive: true });

    await expect(driver.lookup(providerMessageId!)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(driver.send(message())).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("reports the delivery event the dev tool records, and finds a message by its send intent", async () => {
    const driver = new LocalEmailDriver({ spoolDir });
    const { providerMessageId } = await driver.send(message());

    expect(await driver.lookup(providerMessageId!)).toMatchObject({ lastEvent: "sent" });
    expect(await driver.recordEvent(providerMessageId!, "bounced")).toBe(true);
    expect(await driver.lookup(providerMessageId!)).toMatchObject({ lastEvent: "bounced", deliveredMessageId: `<${INTENT_ID}@customer.test>` });
    expect(await driver.findByMessageIdLocalPart(INTENT_ID)).toBe(providerMessageId);
    expect(await driver.lookup("local-00000000000000000000000000000000")).toBeNull();
    expect(await driver.lookup("../../etc/passwd")).toBeNull();
  });
});
