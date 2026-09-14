import RE2 from "re2";

/**
 * Eval assertions are operator-authored and execute against unbounded model output. RE2 keeps
 * that matching linear-time, so an assertion cannot stall an eval worker through backtracking.
 */
export const compileEvalRegex = (pattern: string, caseSensitive: boolean): RegExp =>
  new RE2(pattern, caseSensitive ? "" : "i");
