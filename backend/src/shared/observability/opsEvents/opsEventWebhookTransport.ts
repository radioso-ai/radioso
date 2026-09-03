import { createSignedWebhookHeaders, type WebhookHttpClient } from "../../infra/http/signedWebhook.js";
import type { OpsEventEnvelope } from "./opsEventEnvelope.js";
import type { OpsEventTransport } from "./opsEventDispatcher.js";

export interface SignedWebhookOpsEventTransportOptions {
  url: string;
  secret: string;
}

/**
 * Signs each envelope the same way workspace webhook destinations are signed, so a
 * receiver verifies an ops event with the recipe already documented for skill webhooks.
 * The envelope id doubles as the idempotency key: a retried delivery repeats it.
 */
export class SignedWebhookOpsEventTransport implements OpsEventTransport {
  constructor(
    private readonly httpClient: WebhookHttpClient,
    private readonly options: SignedWebhookOpsEventTransportOptions,
  ) {}

  async send(envelope: OpsEventEnvelope): Promise<void> {
    const rawBody = JSON.stringify(envelope);

    await this.httpClient.post({
      url: this.options.url,
      rawBody,
      headers: createSignedWebhookHeaders({
        rawBody,
        secret: this.options.secret,
        idempotencyKey: envelope.id,
      }),
    });
  }
}
