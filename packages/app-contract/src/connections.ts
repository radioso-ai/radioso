import { z } from "zod";

import { connectionSlotIdSchema, descriptionSchema, displayNameSchema, fieldKeySchema } from "./identifiers.js";

/**
 * A connection slot is where credential material lives. The manifest declares the
 * shape; the host stores the value and hands the App a reference, never the
 * secret itself.
 */
export const connectionSlotKinds = ["secret_fields", "generated_secret", "oauth2"] as const;

export const connectionSlotKindSchema = z.enum(connectionSlotKinds);

const slotHeader = {
  id: connectionSlotIdSchema,
  displayName: displayNameSchema,
  description: descriptionSchema.optional(),
};

export const connectionSecretFieldSchema = z.object({
  key: fieldKeySchema,
  label: displayNameSchema,
  description: descriptionSchema.optional(),
  sensitive: z.boolean(),
  required: z.boolean(),
}).strict();

export const secretFieldsSlotSchema = z.object({
  ...slotHeader,
  kind: z.literal("secret_fields"),
  fields: z.array(connectionSecretFieldSchema).min(1).max(32),
}).strict();

export const generatedSecretSlotSchema = z.object({
  ...slotHeader,
  kind: z.literal("generated_secret"),
  byteLength: z.number().int().min(16).max(64).default(32),
}).strict();

/** Reserved: authorization-code flows arrive with their own release. */
export const oauth2SlotSchema = z.object({
  ...slotHeader,
  kind: z.literal("oauth2"),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1).max(128)).max(32).default([]),
}).strict();

export const connectionSlotSchema = z.discriminatedUnion("kind", [
  secretFieldsSlotSchema,
  generatedSecretSlotSchema,
  oauth2SlotSchema,
]);

export const appConnectionsSchema = z.object({
  slots: z.array(connectionSlotSchema).max(16).default([]),
}).strict();

export type ConnectionSlotKind = z.infer<typeof connectionSlotKindSchema>;
export type ConnectionSlot = z.infer<typeof connectionSlotSchema>;
export type AppConnections = z.infer<typeof appConnectionsSchema>;
