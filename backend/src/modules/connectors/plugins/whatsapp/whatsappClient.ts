import type { ConnectorLogger } from "@radioso/connector-api";

interface WhatsAppClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger: ConnectorLogger;
}

export class WhatsAppClientError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = "WhatsAppClientError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class WhatsAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WhatsAppClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to: input.to,
      type: "text",
      text: { body: input.text },
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
          { phoneNumberId: config.phoneNumberId, outboundWamid: input.outboundWamid, wamid },
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
