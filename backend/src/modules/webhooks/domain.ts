import { z } from "zod";

const WEBHOOK_DESTINATION_LIMITS = {
  name: 200,
  url: 2048,
} as const;

const webhookDestinationNameSchema = z.string()
  .trim()
  .min(1)
  .max(WEBHOOK_DESTINATION_LIMITS.name);

const webhookDestinationUrlSchema = z.string()
  .trim()
  .min(1)
  .max(WEBHOOK_DESTINATION_LIMITS.url);

export const webhookDestinationIdSchema = z.string().uuid();

export const webhookDestinationCreateSchema = z.object({
  name: webhookDestinationNameSchema,
  url: webhookDestinationUrlSchema,
}).strict();

export const webhookDestinationUpdateSchema = webhookDestinationCreateSchema;

export interface WebhookDestinationRecord {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  secretCiphertext: string;
  encryptionKeyId: string;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDestination {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const webhookDeliveryOutcomeStatuses = ["success", "retry", "failed", "skipped"] as const;
export type WebhookDeliveryOutcomeStatus = typeof webhookDeliveryOutcomeStatuses[number];

export interface WebhookDestinationWithSecret {
  destination: WebhookDestination;
  secret: string;
}

export const toWebhookDestination = (record: WebhookDestinationRecord): WebhookDestination => ({
  id: record.id,
  workspaceId: record.workspaceId,
  name: record.name,
  url: record.url,
  lastDeliveryStatus: record.lastDeliveryStatus,
  lastDeliveryAt: record.lastDeliveryAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});
