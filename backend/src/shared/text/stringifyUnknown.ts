/**
 * Coerces a value of unknown or loosely-typed origin (parsed JSON, legacy settings payloads,
 * caught throwables) to a display string, matching the historical `String(value ?? "")` shape:
 * `null`/`undefined` become `""`, and anything else falls back to its own `toString` — including
 * `Object.prototype.toString` for a plain object, which is an accepted degraded output for
 * malformed input rather than a bug.
 */
export const stringifyUnknown = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value;
    case "undefined":
      return "";
    case "object":
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberate: falls back to default Object stringification for a non-null value with no narrower type
      return value === null ? "" : String(value);
    default:
      return String(value);
  }
};
