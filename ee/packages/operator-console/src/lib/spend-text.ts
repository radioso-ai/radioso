import type { ConversationSpend } from "./staff-auth-api";

// Pinned to en-US like the meters, so the console reads the same in every browser locale. Three
// places, because the flag sits at a few cents and two places would round €0.044 down to it.
const eurPerConversation = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const formatEurPerConversation = (value: number): string => eurPerConversation.format(value);

/** The directory's spend column: the month's average, marked partial when unpriced calls are left out. */
export const conversationSpendText = (spend: ConversationSpend | null): string => {
  if (!spend || spend.averageEurPerConversation === null) {
    return "—";
  }
  const average = `${formatEurPerConversation(spend.averageEurPerConversation)} / conv`;
  return spend.unpricedCalls > 0 ? `${average} (partial)` : average;
};
