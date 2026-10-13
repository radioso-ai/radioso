const SUPPRESSIBLE_EMAIL_KINDS = new Set([
  "contact_notification",
  "operator_notice",
  "recipient_confirmation",
]);

export const notificationProviderSuppressionReason = (input: {
  emailKind: string | null;
  status: { type: string; bounce?: { type: string } | null };
}): "hard_bounce" | "complaint" | null => {
  if (!input.emailKind || !SUPPRESSIBLE_EMAIL_KINDS.has(input.emailKind)) return null;
  if (input.status.type === "complained") return "complaint";
  return input.status.type === "bounced" && input.status.bounce?.type.toLowerCase() === "permanent"
    ? "hard_bounce"
    : null;
};
