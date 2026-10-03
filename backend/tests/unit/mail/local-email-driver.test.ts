import { mkdtemp, rm } from "node:fs/promises";
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
