import type { ZodError, ZodIssue } from "zod";

const MAX_DETAILS = 12;
const MAX_KEY_LENGTH = 80;

/**
 * Names where a rejected call went wrong, one line per issue, as `<path>: <zod code>`. Only the
 * issue's path and code travel — never the value at that path — so a rejection cannot carry
 * workspace content back out. An unrecognized key is the caller's own field name echoed to the
 * caller, and naming it is the difference between a correctable call and another guess.
 */
const detailsFor = (issue: ZodIssue): readonly string[] => {
  const path = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => `${[path, key.slice(0, MAX_KEY_LENGTH)].filter(Boolean).join(".")}: ${issue.code}`);
  }
  return [`${path || "(root)"}: ${issue.code}`];
};

export const invalidArgumentDetails = (error: ZodError): readonly string[] =>
  error.issues.flatMap(detailsFor).slice(0, MAX_DETAILS);
