// Runtime values of the `declare`d consts and functions in index.d.ts; everything else in the contract is types only.

export const REPLY_OUTCOMES = Object.freeze(["answered", "no_context", "out_of_scope", "unavailable"]);

export const REPLY_GROUNDINGS = Object.freeze(["grounded", "ungrounded", "not_applicable", "unknown"]);

export const REPLY_COVERAGES = Object.freeze(["answered", "partial", "unanswered", "unclear", "unavailable", "not_assessed"]);

export const REDACTED_VALUE = "[redacted]";

export const redactSensitiveValues = (values, sensitiveKeys) => {
  const sensitive = new Set(sensitiveKeys);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sensitive.has(key) ? REDACTED_VALUE : value]),
  );
};
