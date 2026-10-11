import { createHash } from "node:crypto";

interface RecipientEmailChangeMetadata extends Record<string, unknown> {
  previousRecipientCount: number;
  recipientCount: number;
  previousRecipientHashes: string[];
  recipientHashes: string[];
}

const normalize = (emails: readonly string[]): string[] =>
  [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();

const hashes = (emails: readonly string[]): string[] =>
  emails.map((email) => createHash("sha256").update(email).digest("hex"));

export const recipientEmailsFromDeliveryConfig = (config: Record<string, unknown>): string[] => {
  const delivery = config.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return [];
  const recipients = (delivery as Record<string, unknown>).recipientEmails;
  return Array.isArray(recipients) ? recipients.filter((value): value is string => typeof value === "string") : [];
};

export const recipientEmailChangeMetadata = (
  previous: readonly string[],
  next: readonly string[],
): RecipientEmailChangeMetadata | null => {
  const normalizedPrevious = normalize(previous);
  const normalizedNext = normalize(next);
  if (normalizedPrevious.length === normalizedNext.length
    && normalizedPrevious.every((email, index) => email === normalizedNext[index])) {
    return null;
  }
  return {
    previousRecipientCount: normalizedPrevious.length,
    recipientCount: normalizedNext.length,
    previousRecipientHashes: hashes(normalizedPrevious),
    recipientHashes: hashes(normalizedNext),
  };
};
