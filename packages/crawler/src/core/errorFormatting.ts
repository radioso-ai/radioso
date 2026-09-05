/**
 * Formats a caught value (typed `unknown`) into a human-readable string for a status
 * or trace field. Equivalent to
 * `error instanceof Error ? error.message || error.name : String(error ?? "Unknown error")`,
 * with each non-`Error` branch spelled out so none of them stringifies a bare `unknown`.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (error === null || error === undefined) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (typeof error === "function" || typeof error === "symbol") {
    return error.toString();
  }
  return Array.isArray(error) ? error.toString() : Object.prototype.toString.call(error);
};
