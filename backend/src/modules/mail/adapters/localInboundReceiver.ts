import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  InboundFetchError,
  type InboundEmailMessage,
  type InboundEmailReceiver,
  type InboundVerification,
} from "../inboundEmailReceiver.js";
import { normalizeInboundMime } from "../inboundMimeNormalizer.js";
import { ResendWebhookVerifier, type WebhookSigningSecrets } from "./resendWebhook.js";

/**
 * Local development and test stand-in for a receiving provider. Webhooks use Resend's wire
 * format and signature, so the production verification path runs unchanged; message content is
 * read from `${spoolDir}/${id}.eml`, written there by the dev tool. A local message has no
 * provider authentication results or spam verdict, so both are `unknown`.
 */

interface LocalInboundReceiverOptions {
  spoolDir: string;
  signingSecrets: WebhookSigningSecrets;
}

/** Spool ids are file names, never paths. */
const SPOOL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class LocalInboundEmailReceiver implements InboundEmailReceiver {
  readonly provider = "local";
  private readonly verifier: ResendWebhookVerifier;

  constructor(private readonly options: LocalInboundReceiverOptions) {
    this.verifier = new ResendWebhookVerifier(options.signingSecrets);
  }

  verify(request: Parameters<InboundEmailReceiver["verify"]>[0]): InboundVerification {
    return this.verifier.verify(request);
  }

  async fetchMessage(providerObjectId: string): Promise<InboundEmailMessage> {
    if (!SPOOL_ID.test(providerObjectId)) {
      throw new InboundFetchError(false, "invalid_message_id");
    }
    const raw = await this.readSpooled(providerObjectId);
    return normalizeInboundMime(raw, {
      receivedFor: [],
      authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
      spamVerdict: "unknown",
    });
  }

  private async readSpooled(id: string): Promise<Buffer> {
    try {
      return await readFile(join(this.options.spoolDir, `${id}.eml`));
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      throw missing ? new InboundFetchError(false, "message_not_found") : new InboundFetchError(true, "spool_unreadable");
    }
  }
}
