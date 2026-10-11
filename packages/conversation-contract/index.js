// Runtime values of the `declare const`s in index.d.ts; everything else in the contract is types only.

export const REPLY_OUTCOMES = Object.freeze(["answered", "no_context", "out_of_scope", "unavailable"]);

export const REPLY_GROUNDINGS = Object.freeze(["grounded", "ungrounded", "not_applicable", "unknown"]);

export const REPLY_COVERAGES = Object.freeze(["answered", "partial", "unanswered", "unclear", "unavailable", "not_assessed"]);
