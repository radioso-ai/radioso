/**
 * What kind of error something threw, for a log field: the error's own name when it set one, else
 * its class, so a subclass that leaves `name` alone still reads as itself. Never the message, which
 * can carry a key, a URL or what a caller said.
 */
export const errorClassOf = (error: unknown): string => {
  if (!(error instanceof Error)) return typeof error;
  return error.name && error.name !== "Error" ? error.name : error.constructor.name;
};
