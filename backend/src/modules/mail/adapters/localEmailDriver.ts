import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseRfcMessageId } from "../emailHeaderValues.js";
import { EmailSendError } from "../emailSendErrors.js";
import type { EmailDriver, EmailMessage, EmailSendResult, SentEmailLastEvent, SentEmailStatus } from "../emailService.js";
import { hasFileErrorCode } from "./localSpool.js";
import { isRecord } from "./resendApi.js";

/**
 * Local development and test stand-in for the channel's sending provider. Each accepted message
 * is kept as a JSON file under `${spoolDir}/outbound/`, which the API and worker processes share.
 * It honours idempotency keys the way the provider does: the same key returns the same id, and a
 * different body under a used key is refused, across every process sharing the spool. Nothing
 * delivers a local message on its own: the dev tool (`email:dev delivery`) records a delivery event
 * with `recordEvent` and posts its webhook.
 *
 * A spool file is only ever published whole: it is written aside, then linked into place for the
 * first acceptance (which fails if another process got there first) or renamed over the old one for
 * an update, so no reader sees a partial file and no acceptance overwrites another.
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
    const candidate: LocalSentEmail = {
      providerMessageId,
      rfcMessageId: message.threading?.messageId ?? null,
      bodyHash,
      lastEvent: "sent",
      message,
    };
    const sent = (await this.publishIfAbsent(candidate)) ? candidate : await this.readAccepted(providerMessageId);
    if (sent.bodyHash !== bodyHash) {
      throw new EmailSendError("rejected", "idempotency_body_mismatch");
    }
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
    await this.replace({ ...sent, lastEvent });
    return true;
  }

  /** The local message whose Message-ID has `localPart` before its `@`, such as a send intent's id. */
  async findByMessageIdLocalPart(localPart: string): Promise<string | null> {
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if (hasFileErrorCode(error, "ENOENT")) return null;
      throw error;
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

  private pathOf(providerMessageId: string): string {
    return join(this.directory(), `${providerMessageId}.json`);
  }

  private async read(providerMessageId: string): Promise<LocalSentEmail | null> {
    if (!SPOOL_ID.test(providerMessageId)) return null;
    let text: string;
    try {
      text = await readFile(this.pathOf(providerMessageId), "utf8");
    } catch (error) {
      if (hasFileErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return isLocalSentEmail(parsed) ? parsed : null;
  }

  /** The message another send published first under the same key. */
  private async readAccepted(providerMessageId: string): Promise<LocalSentEmail> {
    const accepted = await this.read(providerMessageId);
    if (!accepted) throw new Error(`Local spool entry ${providerMessageId} is not a sent message`);
    return accepted;
  }

  /** Publishes `sent` unless a message already holds its id. True when this call published it. */
  private async publishIfAbsent(sent: LocalSentEmail): Promise<boolean> {
    const staged = await this.stage(sent);
    try {
      await link(staged, this.pathOf(sent.providerMessageId));
      return true;
    } catch (error) {
      if (hasFileErrorCode(error, "EEXIST")) return false;
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
  }

  private async replace(sent: LocalSentEmail): Promise<void> {
    const staged = await this.stage(sent);
    try {
      await rename(staged, this.pathOf(sent.providerMessageId));
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }

  /** Writes `sent` to a fresh staging file beside its spool file; never read as a message. */
  private async stage(sent: LocalSentEmail): Promise<string> {
    await mkdir(this.directory(), { recursive: true });
    const staged = join(this.directory(), `${sent.providerMessageId}.${randomUUID()}.tmp`);
    await writeFile(staged, JSON.stringify(sent), { flag: "wx" });
    return staged;
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
