import { z } from "zod";

import { parseRfcMessageId, type DeliveryStatusFacts } from "../../../mail/public.js";

/**
 * The provider delivery-status envelope the email webhook persisted (`emailWebhook.ts`'s
 * `eventRowOf`), read back structurally so the inbound processor never trusts its own write.
 */
interface ParsedDeliveryStatus {
  status: DeliveryStatusFacts;
  /**
   * The RFC Message-ID the event carried, if any; null for an event persisted before this field
   * existed, or one from a provider that carries none (#1619).
   */
  rfcMessageId: string | null;
}

/** Tokens the provider adapter already reduced the bounce detail to; re-checked when read back. */
const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ENHANCED_STATUS_CODE = /^[245]\.\d{1,3}\.\d{1,3}$/u;

const deliveryStatusSchema = z.object({
  status: z.object({
    type: z.enum(["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed"]),
    bounce: z
      .object({
        type: z.string().regex(PROVIDER_TOKEN),
        subType: z.string().regex(PROVIDER_TOKEN).nullable(),
        statusCode: z.string().regex(ENHANCED_STATUS_CODE).nullable(),
      })
      .nullable(),
  }),
  // Held to the same length and syntax the provider adapter checked before persisting it.
  rfcMessageId: z.string().refine((value) => parseRfcMessageId(value) !== null).nullable().optional(),
});

/** The delivery status the webhook persisted; null when it is not one this processor can read. */
export const readDeliveryStatus = (envelope: unknown): ParsedDeliveryStatus | null => {
  const parsed = deliveryStatusSchema.safeParse(envelope);
  return parsed.success ? { status: parsed.data.status, rfcMessageId: parsed.data.rfcMessageId ?? null } : null;
};
