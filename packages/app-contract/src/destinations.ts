import { z } from "zod";

import { connectionSlotIdSchema, destinationIdSchema, fieldKeySchema } from "./identifiers.js";

/**
 * Every network address an App may reach is declared here and nowhere else. A
 * host is either a fixed pattern the author knows at publish time or a field the
 * operator fills in, which is what makes one release usable against many sites.
 */
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/**
 * `http` is here because a self-hosted site reachable only over plain HTTP is a
 * real, currently-working installation. Admitting it narrowly — declared,
 * operator-visible on the grant screen, one destination at a time — is what lets
 * those installations move onto the runtime instead of being stranded by it.
 */
export const destinationProtocols = ["https", "http"] as const;
export const destinationProtocolSchema = z.enum(destinationProtocols);

/** What leaves the platform on this destination, shown to the operator on the grant screen. */
export const destinationDataClasses = [
  "document_content",
  "document_metadata",
  "installation_configuration",
  "credentials",
  "operational_metadata",
] as const;
export const destinationDataClassSchema = z.enum(destinationDataClasses);

export const destinationHostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pattern"), pattern: z.string().regex(HOST_PATTERN) }).strict(),
  z.object({ kind: z.literal("configuration"), field: fieldKeySchema }).strict(),
]);

export const destinationSchema = z.object({
  id: destinationIdSchema,
  host: destinationHostSchema,
  protocols: z.array(destinationProtocolSchema).min(1).max(destinationProtocols.length),
  ports: z.array(z.number().int().min(1).max(65535)).max(4).optional(),
  purpose: z.string().min(1).max(256),
  dataClasses: z.array(destinationDataClassSchema).min(1).max(destinationDataClasses.length),
  connectionSlot: connectionSlotIdSchema.optional(),
}).strict();

export type DestinationProtocol = z.infer<typeof destinationProtocolSchema>;
export type DestinationDataClass = z.infer<typeof destinationDataClassSchema>;
export type DestinationHost = z.infer<typeof destinationHostSchema>;
export type Destination = z.infer<typeof destinationSchema>;
