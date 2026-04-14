export const retrievalConstraintSignalKeys = [
  "document_location",
  "document_amount",
  "document_date",
  "document_period",
] as const;

export type RetrievalConstraintSignalKey = (typeof retrievalConstraintSignalKeys)[number];

export const retrievalConstraintOperators = {
  document_location: ["match"],
  document_amount: ["eq", "lte", "gte"],
  document_date: ["eq", "lte", "gte"],
  document_period: ["eq", "lte", "gte"],
} as const satisfies Record<RetrievalConstraintSignalKey, readonly string[]>;

export type RetrievalConstraintOperator = (typeof retrievalConstraintOperators)[RetrievalConstraintSignalKey][number];

export const isRetrievalConstraintSignalKey = (value: string): value is RetrievalConstraintSignalKey =>
  retrievalConstraintSignalKeys.includes(value as RetrievalConstraintSignalKey);

export const isRetrievalConstraintOperator = (
  signalKey: RetrievalConstraintSignalKey,
  operator: string,
): operator is RetrievalConstraintOperator =>
  retrievalConstraintOperators[signalKey].includes(operator as never);

export const renderRetrievalConstraintPromptSection = (): string =>
  retrievalConstraintSignalKeys
    .map((signalKey) => `- ${signalKey}`)
    .join("\n");

export const renderRetrievalConstraintOperatorPromptSection = (): string =>
  retrievalConstraintSignalKeys
    .map((signalKey) => `- ${signalKey}: ${retrievalConstraintOperators[signalKey].join(" | ")}`)
    .join("\n");
