import { z } from "zod";

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalTrimmedText = (maxLength: number) =>
  z.preprocess((value) => (value === "" ? null : value), z.string().trim().min(1).max(maxLength).nullable().optional());

export const customerEmailConnectionStatuses = ["authorized", "disabled", "needs_reauth", "error"] as const;
export type CustomerEmailConnectionStatus = (typeof customerEmailConnectionStatuses)[number];

export const customerEmailHealthStatuses = ["ok", "failed", "unknown"] as const;
export type CustomerEmailHealthStatus = (typeof customerEmailHealthStatuses)[number];

export const customerEmailConnectionCreateSchema = z
  .object({
    oauthConnectionId: z.string().uuid(),
    displayName: trimmedText(160),
    senderEmail: z.string().trim().email().max(320),
    senderName: optionalTrimmedText(160),
    replyToEmail: optionalTrimmedText(320).pipe(z.string().email().max(320).nullable().optional()),
  })
  .strict();

export type CustomerEmailConnectionCreateInput = z.infer<typeof customerEmailConnectionCreateSchema>;

export const customerEmailConnectionUpdateSchema = z
  .object({
    displayName: trimmedText(160).optional(),
    senderEmail: z.string().trim().email().max(320).optional(),
    senderName: optionalTrimmedText(160),
    replyToEmail: optionalTrimmedText(320).pipe(z.string().email().max(320).nullable().optional()),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" });

export type CustomerEmailConnectionUpdateInput = z.infer<typeof customerEmailConnectionUpdateSchema>;

export interface CustomerEmailConnectionSummary {
  id: string;
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  senderEmail: string;
  senderName: string | null;
  replyToEmail: string | null;
  status: CustomerEmailConnectionStatus;
  lastHealthStatus: CustomerEmailHealthStatus | null;
  lastHealthCheckedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
}
