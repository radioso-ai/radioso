import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseRfcMessageId } from "../emailHeaderValues.js";
import { EmailSendError } from "../emailSendErrors.js";
import type { EmailDriver, EmailMessage, EmailSendResult, SentEmailLastEvent, SentEmailStatus } from "../emailService.js";
import { isRecord } from "./resendApi.js";

/**
 * Local development and test stand-in for the channel's sending provider. Each accepted message
 * is kept as a JSON file under `${spoolDir}/outbound/`, which the API and worker processes share.
 * It honours idempotency keys the way the provider does: the same key returns the same id, and a
 * different body under a used key is refused. Nothing delivers a local message on its own: the dev
 * tool (`email:dev delivery`) records a delivery event with `recordEvent` and posts its webhook.
 */

interface LocalEmailDriverOptions {
  spoolDir: string;
}

interface LocalSentEmail {
  providerMessageId: string;
  /** The Message-ID the message carries; the local provider delivers under the supplied one. */
  rfcMessageId: string | null;
  bodyHash: string;
  lastEvent: SentEmailLastEvent;
  message: EmailMessage;
}

const ID_PREFIX = "local-";
const LAST_EVENTS: ReadonlySet<string> = new Set<SentEmailLastEvent>([
  "queued", "sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed", "unknown",
]);
const SPOOL_ID = /^local-[0-9a-f]{32}$/u;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const bodyHashOf = (message: EmailMessage): string =>
  sha256(JSON.stringify([message.to, message.from, message.replyTo ?? null, message.subject, message.text, message.html ?? null, message.threading ?? null]));

export class LocalEmailDriver implements EmailDriver {
  constructor(private readonly options: LocalEmailDriverOptions) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const key = message.idempotencyKey ?? randomUUID();
    const providerMessageId = `${ID_PREFIX}${sha256(key).slice(0, 32)}`;
    const bodyHash = bodyHashOf(message);
    const existing = await this.read(providerMessageId);
    if (existing && existing.bodyHash !== bodyHash) {
      throw new EmailSendError("rejected", "idempotency_body_mismatch");
    }
    const sent: LocalSentEmail = existing ?? {
      providerMessageId,
      rfcMessageId: message.threading?.messageId ?? null,
      bodyHash,
      lastEvent: "sent",
      message,
    };
    if (!existing) await this.write(sent);
    return { dispatched: true, providerMessageId, deliveredMessageId: parseOrNull(sent.rfcMessageId) };
  }

  async lookup(providerMessageId: string): Promise<SentEmailStatus | null> {
    const sent = await this.read(providerMessageId);
    return sent ? { providerMessageId, deliveredMessageId: parseOrNull(sent.rfcMessageId), lastEvent: sent.lastEvent } : null;
  }

  /** Records a delivery event for a local message, so `lookup` reports it. */
  async recordEvent(providerMessageId: string, lastEvent: SentEmailLastEvent): Promise<boolean> {
    const sent = await this.read(providerMessageId);
    if (!sent) return false;
    await this.write({ ...sent, lastEvent });
    return true;
  }

  /** The local message whose Message-ID has `localPart` before its `@`, such as a send intent's id. */
  async findByMessageIdLocalPart(localPart: string): Promise<string | null> {
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch {
      return null;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const sent = await this.read(name.slice(0, -".json".length));
      if (sent?.rfcMessageId?.startsWith(`<${localPart}@`)) return sent.providerMessageId;
    }
    return null;
  }

  private directory(): string {
    return join(this.options.spoolDir, "outbound");
  }

  private async read(providerMessageId: string): Promise<LocalSentEmail | null> {
    if (!SPOOL_ID.test(providerMessageId)) return null;
    let text: string;
    try {
      text = await readFile(join(this.directory(), `${providerMessageId}.json`), "utf8");
    } catch {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return isLocalSentEmail(parsed) ? parsed : null;
  }

  private async write(sent: LocalSentEmail): Promise<void> {
    await mkdir(this.directory(), { recursive: true });
    await writeFile(join(this.directory(), `${sent.providerMessageId}.json`), JSON.stringify(sent));
  }
}

const parseOrNull = (value: string | null) => (value === null ? null : parseRfcMessageId(value));

const isLocalSentEmail = (value: unknown): value is LocalSentEmail =>
  isRecord(value)
  && typeof value.providerMessageId === "string"
  && (value.rfcMessageId === null || typeof value.rfcMessageId === "string")
  && typeof value.bodyHash === "string"
  && typeof value.lastEvent === "string"
  && LAST_EVENTS.has(value.lastEvent)
  && isRecord(value.message);
