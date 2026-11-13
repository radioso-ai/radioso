import type { ConnectorLogger } from "@radioso/connector-api";

import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { WHATSAPP_GRAPH_BASE_URL, WhatsAppClientError } from "./whatsappGraph.js";
import {
  WHATSAPP_MEDIA_DEFAULT_MAX_BYTES,
  WHATSAPP_MEDIA_DEFAULT_TIMEOUT_MS,
  downloadWhatsAppMedia,
  type WhatsAppMediaDownload,
} from "./whatsappMedia.js";
import type { WhatsAppOutboundMessage } from "./whatsappReplyCards.js";

export { WhatsAppClientError };

interface WhatsAppClientOptions {
  fetch?: typeof fetch;
  /** Fetches the media link Graph names; defaults to `fetch`. A host-bound public transport belongs here. */
  mediaFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger: ConnectorLogger;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  /** The largest photo a download accepts. */
  mediaMaxBytes?: number;
  /** The time one photo's download may take, Graph call included. */
  mediaTimeoutMs?: number;
}

/** How a photo download ended. Closed: no workspace, number or media id ever becomes a label. */
type WhatsAppMediaOutcome = "downloaded" | "not_found" | "too_large" | "invalid_response" | "failed";

export class WhatsAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly mediaFetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WhatsAppClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.mediaFetchImpl = options.mediaFetch ?? this.fetchImpl;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Downloads the photo of an inbound image message. A photo that cannot be had comes back as
   * `unavailable`; a transient failure throws a retryable `WhatsAppClientError`. The media URL is
   * a bearer-protected link, so no line here carries it, the token or the bytes: the message id
   * names the attempt.
   */
  async downloadImage(
    config: { accessToken: string },
    input: { mediaId: string; wamid: string },
  ): Promise<WhatsAppMediaDownload> {
    try {
      const result = await downloadWhatsAppMedia(
        {
          graphFetch: this.fetchImpl,
          mediaFetch: this.mediaFetchImpl,
          maxBytes: this.options.mediaMaxBytes ?? WHATSAPP_MEDIA_DEFAULT_MAX_BYTES,
          timeoutMs: this.options.mediaTimeoutMs ?? WHATSAPP_MEDIA_DEFAULT_TIMEOUT_MS,
        },
        { accessToken: config.accessToken, mediaId: input.mediaId },
      );
      const outcome = result.kind === "downloaded" ? "downloaded" : result.reason;
      this.recordMediaOutcome(outcome);
      this.options.logger.info({ wamid: input.wamid, outcome }, "WhatsApp media download finished");
      return result;
    } catch (error) {
      this.recordMediaOutcome("failed");
      this.options.logger.warn(
        { wamid: input.wamid, outcome: "failed", statusCode: error instanceof WhatsAppClientError ? error.statusCode : undefined },
        "WhatsApp media download failed",
      );
      throw error;
    }
  }

  private recordMediaOutcome(outcome: WhatsAppMediaOutcome): void {
    this.options.metrics?.incrementCounter("whatsapp_media_downloads_total", {
      help: "Photos downloaded from WhatsApp for a turn, by outcome: downloaded, gone, over the size cap, not a usable link, or a failure worth retrying",
      labels: { outcome },
    });
  }

  async sendTextMessage(
    config: {
      phoneNumberId: string;
      accessToken: string;
    },
    input: {
      to: string;
      text: string;
      /**
       * The caller's own local message id. Every log line below names the attempt by this
       * instead of `to`, the visitor's phone number: it is internal, stable for the attempt
       * (including its retries), and already how the caller correlates its own records.
       */
      outboundWamid: string;
    },
  ): Promise<{ wamid: string }> {
    return this.sendMessage(config, { to: input.to, message: { type: "text", text: { body: input.text } }, outboundWamid: input.outboundWamid });
  }

  /**
   * Sends one message of a reply: text, an image or an interactive message. Retries a rate limit
   * twice; any other refusal throws a `WhatsAppClientError` with Graph's status.
   */
  async sendMessage(
    config: {
      phoneNumberId: string;
      accessToken: string;
    },
    input: {
      to: string;
      message: WhatsAppOutboundMessage;
      /** The caller's own local message id, which names the attempt in every log line (see `sendTextMessage`). */
      outboundWamid: string;
    },
  ): Promise<{ wamid: string }> {
    const url = `${WHATSAPP_GRAPH_BASE_URL}/${config.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to: input.to,
      ...input.message,
    };

    let attempt = 0;
    let delayMs = 500;

    while (attempt < 3) {
      attempt += 1;

      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const payload = await response.json() as { messages?: Array<{ id?: string }> };
        const wamid = payload.messages?.[0]?.id;
        if (!wamid) {
          throw new WhatsAppClientError("WhatsApp response did not include a message id", 502, false);
        }

        this.options.logger.info(
          { phoneNumberId: config.phoneNumberId, outboundWamid: input.outboundWamid, wamid, messageType: body.type },
          "WhatsApp reply sent",
        );
        return { wamid };
      }

      const errorPayload = await this.parseErrorResponse(response);
      // The provider's own error text can quote the request back (seen above repeating a phone
      // number) or describe the account's configuration, so it is used only to throw — the caller
      // reports it through the error sinks — and never appears in this method's own log lines.
      const message = errorPayload?.error?.message ?? `WhatsApp API request failed with status ${response.status}`;

      if (response.status === 429 && attempt < 3) {
        this.options.logger.warn(
          { outboundWamid: input.outboundWamid, delayMs, attempt, statusCode: response.status },
          "WhatsApp rate limited",
        );
        await this.sleep(delayMs);
        delayMs *= 2;
        continue;
      }

      this.options.logger.error(
        { outboundWamid: input.outboundWamid, statusCode: response.status },
        "WhatsApp send failed",
      );
      throw new WhatsAppClientError(message, response.status, response.status === 429);
    }

    throw new WhatsAppClientError("WhatsApp API request failed after retries", 429, true);
  }

  private async parseErrorResponse(response: Response): Promise<{ error?: { message?: string } } | null> {
    try {
      return await response.json() as { error?: { message?: string } };
    } catch {
      return null;
    }
  }
}
