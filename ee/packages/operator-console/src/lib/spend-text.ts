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

/** The month's average, as a floor (`≥`) when calls on unpriced models are missing from it. */
export const averageText = (spend: ConversationSpend): string => {
  if (spend.averageEurPerConversation === null) {
    return "—";
  }
  const average = formatEurPerConversation(spend.averageEurPerConversation);
  return spend.unpricedCalls > 0 ? `≥ ${average}` : average;
};

/** The directory's spend column. An average under the flag with unpriced calls missing could be
 *  over it, so it reads as undetermined rather than as a clean pass. */
export const conversationSpendText = (spend: ConversationSpend | null): string => {
  if (!spend || spend.averageEurPerConversation === null) {
    return "—";
  }
  const text = `${averageText(spend)} / conv`;
  return spend.flag === "undetermined" ? `${text} (undetermined)` : text;
};
