import type {
  WebhookDestination,
  WebhookDestinationWithSecret,
} from "../../../modules/webhooks/public.js";

export const presentWebhookDestination = (destination: WebhookDestination) => ({
  id: destination.id,
  name: destination.name,
  url: destination.url,
  lastDeliveryStatus: destination.lastDeliveryStatus,
  lastDeliveryAt: destination.lastDeliveryAt?.toISOString() ?? null,
  createdAt: destination.createdAt.toISOString(),
  updatedAt: destination.updatedAt.toISOString(),
});

export const presentWebhookDestinationWithSecret = (input: WebhookDestinationWithSecret) => ({
  destination: presentWebhookDestination(input.destination),
  secret: input.secret,
});

