type MailboxReceivingState = "waiting_for_first_message" | "ok" | "silent";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Derived, never stored. Informational only: Radioso cannot see a customer's forwarding rule
 * break, so silence past the mailbox's threshold is the one signal it has.
 */
export const deriveReceivingState = (input: {
  lastReceivedAt: Date | null;
  silenceThresholdHours: number;
  now: Date;
}): MailboxReceivingState => {
  if (input.lastReceivedAt === null) return "waiting_for_first_message";
  const silentForMs = input.now.getTime() - input.lastReceivedAt.getTime();
  return silentForMs > input.silenceThresholdHours * HOUR_MS ? "silent" : "ok";
};
