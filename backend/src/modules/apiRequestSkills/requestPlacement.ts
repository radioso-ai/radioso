import { isBodyMethod, pathPlaceholders, type ApiRequestMethod } from "./domain.js";

type PlacedApiRequest =
  | { kind: "placed"; url: string; body?: string }
  /** A path value that cannot be one URL segment: not a scalar, empty, or able to leave its segment. */
  | { kind: "invalid_input"; param: string };

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const decodedOnce = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * A value that could step out of its segment on a target that decodes the path: one holding a
 * `/` or `\`, a `.` or `..` segment, or any of these once percent-decoded (a target that decodes
 * twice reads `%2e%2e` as `..`).
 */
const leavesItsSegment = (text: string): boolean =>
  [text, decodedOnce(text)].some((form) =>
    /[/\\]/u.test(form) || form.split(/[/\\]/u).some((part) => part === "." || part === ".."));

const pathSegmentValue = (value: unknown): string | null => {
  if (!isScalar(value)) return null;
  const text = String(value);
  return text.length === 0 || leavesItsSegment(text) ? null : encodeURIComponent(text);
};

const queryValues = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(queryValues);
  return [isScalar(value) ? String(value) : JSON.stringify(value)];
};

/** Writes `customer.email` as `{ customer: { email } }`. Keys were validated as safe segments on save. */
const nestedBody = (params: ReadonlyArray<[string, unknown]>): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const segments = key.split(".");
    let target = body;
    for (const segment of segments.slice(0, -1)) {
      const next = Object.hasOwn(target, segment) ? target[segment] : undefined;
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[segments[segments.length - 1]] = value;
  }
  return body;
};

/**
 * Places a request's params with no template language: a param a `{placeholder}` names fills that
 * path segment, URL-encoded; the rest go into the query string for GET and DELETE, or into a JSON
 * body for POST, PUT and PATCH, where a dotted key nests. The path is appended to the connection's
 * base URL, and the result never leaves the base URL's origin.
 */
export const placeApiRequest = (input: {
  baseUrl: string;
  method: ApiRequestMethod;
  path: string;
  params: Readonly<Record<string, unknown>>;
}): PlacedApiRequest => {
  const placeholders = new Set(pathPlaceholders(input.path) ?? []);
  let path = input.path;
  for (const name of placeholders) {
    const segment = pathSegmentValue(input.params[name]);
    if (segment === null) return { kind: "invalid_input", param: name };
    path = path.split(`{${name}}`).join(segment);
  }
  const base = new URL(input.baseUrl);
  const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/u, "")}${path}`);
  if (url.origin !== base.origin) {
    return { kind: "invalid_input", param: "path" };
  }
  const rest = Object.entries(input.params).filter(([key]) => !placeholders.has(key));
  if (isBodyMethod(input.method)) {
    return { kind: "placed", url: url.toString(), body: JSON.stringify(nestedBody(rest)) };
  }
  for (const [key, value] of rest) {
    for (const text of queryValues(value)) url.searchParams.append(key, text);
  }
  return { kind: "placed", url: url.toString() };
};
