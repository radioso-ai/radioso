const isUndispatchedMailResult = (value: unknown): value is { dispatched: false; driver?: string } =>
  !!value && typeof value === "object" && "dispatched" in value && value.dispatched === false;

/**
 * A mailer that records rather than sends must be visible as a skipped action. Mail
 * implementations predating the dispatched result are treated as successful for
 * compatibility; only an explicit false changes the durable outbox outcome.
 */
export const mailDeliverySkipReason = (results: readonly unknown[]) => {
  if (results.length === 0 || !results.every(isUndispatchedMailResult)) {
    return null;
  }
  const drivers = new Set(results.map((result) => result.driver));
  const [driver] = drivers;
  const safeDriver = drivers.size === 1 && typeof driver === "string" && /^[a-z0-9_-]{1,32}$/u.test(driver)
    ? driver
    : "unknown";
  return `mail_not_dispatched:driver=${safeDriver}` as const;
};
